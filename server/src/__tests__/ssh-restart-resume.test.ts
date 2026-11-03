import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, budgetReservations, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport,
  startSshEnvLabFixture, stopSshEnvLabFixture } from "@paperclipai/adapter-utils/ssh";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createGitRepo, seedRunTarget, wakeIssue } from "./helpers/ssh-in-place-heartbeat.js";
import { heartbeatService } from "../services/heartbeat.js";
import { SSH_IN_PLACE_ENVIRONMENTS_ENV, releaseSshInPlaceWorktreeLocksForLease } from "../services/ssh-in-place-workspace.js";

const execute = vi.hoisted(() => vi.fn<typeof executeCodex>());
vi.mock("../adapters/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));
// Use the fixture's keys. The SSH transport, stop probe, and database remain real.
vi.mock("../services/environment-config.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: unknown, environment: { config: unknown }) =>
    ({ driver: "ssh", config: environment.config }),
}));
// The fixture provider never calls the Paperclip API.
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

const postgresSupport = await getEmbeddedPostgresTestSupport();
const sshSupport = await getSshEnvLabSupport();
const containmentSupported = await promisify(execFile)("systemd-run", ["--user", "--scope", "--quiet", "--expand-environment=no", "true"], {
  env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` },
}).then(() => true, () => false);

describe.skipIf(!postgresSupport.supported || !sshSupport.supported || !containmentSupported)("SSH restart resume", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let repo: string;
  let fixture: Awaited<ReturnType<typeof startSshEnvLabFixture>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("ssh-restart-resume-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-restart-resume-"));
    repo = await createGitRepo();
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh", "state.json") });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Test", email: "ssh-resume@example.test",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture);
    if (db) for (const lease of await db.select().from(environmentLeases)) releaseSshInPlaceWorktreeLocksForLease(lease.id);
    await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (repo) await fs.rm(repo, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("records shutdown receipts, then resumes the same SSH Codex run once", async () => {
    const config = await buildSshEnvLabFixtureConfig(fixture);
    const seeded = await seedRunTarget(db, { repoRoot: repo, remoteBase: config.remoteWorkspacePath });
    await db.update(environments).set({ config }).where(eq(environments.id, seeded.environmentId));
    vi.stubEnv(SSH_IN_PLACE_ENVIRONMENTS_ENV, seeded.environmentId);
    const sessionId = "01234567-89ab-4cde-8f01-23456789abcd";
    const command = path.join(root, "codex");
    const capture = path.join(root, "invocations.jsonl");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-key" }));
    await fs.writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt: fs.readFileSync(0, 'utf8') }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(sessionId)} }));
if (args.includes('resume')) {
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
} else { setInterval(() => {}, 1000); }
`, { mode: 0o755 });
    await db.update(agents).set({ adapterConfig: { engine: "cli", command,
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: "fixture-key" } } }).where(eq(agents.id, seeded.agentId));
    execute.mockImplementation(async input => {
      if (input.context.paperclipRestartResume) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
        expect(run.executionControlDeadlineAt).toBeNull();
      }
      const result = await executeCodex(input);
      if (input.context.paperclipRestartResume && result.exitCode === 0) {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
      }
      return result;
    });
    const previous = heartbeatService(db), replacement = heartbeatService(db);
    try {
      const wake = await wakeIssue(previous, seeded.agentId, seeded.issueId);
      await expect.poll(async () => {
        const run = await previous.getRun(wake!.id);
        return run?.resultJson?.restartCheckpoint ?? { status: run?.status, error: run?.error, stderr: run?.stderrExcerpt };
      }, { timeout: 30_000 }).toMatchObject({ sessionParams: { sessionId, remoteExecution: { transport: "ssh" } } });
      expect(await previous.drainRunningRunsForShutdown("SIGTERM", new Date(), [wake!.id]))
        .toMatchObject({ restartSuspendedRunIds: [wake!.id], interruptedRunIds: [] });
      await previous.drainActiveRunExecutions();
      const suspended = await previous.getRun(wake!.id);
      expect(suspended).toMatchObject({ status: "running", resultJson: {
        restartCheckpoint: { providerStopped: true, workspaceSettled: true },
      } });
      await replacement.reapOrphanedRuns();
      await replacement.drainActiveRunExecutions();
      const completed = await replacement.getRun(wake!.id);
      expect({ status: completed?.status, error: completed?.error, result: completed?.resultJson })
        .toMatchObject({ status: "succeeded", result: { restartRecovery: { outcome: "resumed" } } });
      await replacement.reapOrphanedRuns();
      await replacement.drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledTimes(2);
      const invocations = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(invocations).toHaveLength(2);
      expect(invocations[1].args).toEqual(expect.arrayContaining(["resume", sessionId]));
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId))).toHaveLength(1);
      expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, wake!.id))).toHaveLength(1);
    } finally {
      await previous.drainRunningRunsForShutdown("SIGTERM");
      await previous.drainActiveRunExecutions();
      await replacement.drainActiveRunExecutions();
    }
  }, 90_000);
});
