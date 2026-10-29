import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.ts";

// SYNA-1817: persisted-row evidence. Real process runs print credential shapes; the stored row must not hold them.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.PAPERCLIP_REQUIRE_PERSISTENCE_REDACTION_TESTS === "1") throw new Error(support.reason ?? "Embedded Postgres is required");
// Synthetic, well-formed but fake values.
const BOARD_KEY = `pcp_board_${"0a1b2c3d4e5f".repeat(4)}`;
const GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const OPAQUE_ASSIGNMENT = `OPENCLAW_TOKEN=${"Zq9".repeat(366)}`;
const REGISTERED = "registered-opaque-Value-7f3k2m9x";

(support.supported ? describe : describe.skip)("heartbeat run persistence redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "b".repeat(64));
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-persistence-redaction-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  async function seed(script: string, extra: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Redaction", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Printer", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script], ...extra },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Print", status: "todo", priority: "high",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function runOnce(script: string, extra: Record<string, unknown> = {}, during?: (run: { id: string; companyId: string }) => Promise<void>) {
    const { companyId, agentId, issueId } = await seed(script, extra);
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system", requestedByActorId: "issue_assignment",
    });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).then((rows) => rows[0]!);
    if (during) await during({ id: run.id, companyId });
    await heartbeat.drainActiveRunExecutions();
    const stored = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]!);
    // The ndjson run log as stored on disk, read back through the service.
    const log = stored.logRef ? JSON.stringify(await heartbeat.readLog(run.id, { limitBytes: 1_000_000 })) : "";
    return { stored, log, text: JSON.stringify([stored.error, stored.stdoutExcerpt, stored.stderrExcerpt, stored.resultJson]) + log };
  }

  const leak = (value: string) => `console.log(${JSON.stringify(value)}); console.error(${JSON.stringify(value)});`;

  it("masks shapes in a succeeded run's stored row", async () => {
    const { stored, text } = await runOnce(`${leak(`key ${BOARD_KEY}`)} ${leak(GH)} ${leak(OPAQUE_ASSIGNMENT)}`);
    expect(stored.status).toBe("succeeded");
    for (const value of [BOARD_KEY, GH, OPAQUE_ASSIGNMENT.slice(15)]) expect(text).not.toContain(value);
    expect(text).toContain("OPENCLAW_TOKEN=");
  }, 30_000);

  it("writes the run log file with the same policy", async () => {
    const { log } = await runOnce(`${leak(`key ${BOARD_KEY}`)} ${leak(GH)}`);
    expect(log.length).toBeGreaterThan(0);
    expect(log).toContain("key ");
    expect(log).not.toContain(BOARD_KEY);
    expect(log).not.toContain(GH);
  }, 30_000);

  it("masks shapes in a failed run's stored row, including the error", async () => {
    const { stored, text } = await runOnce(`${leak(`Authorization: Bearer ${GH}`)} ${leak(BOARD_KEY)} process.exit(3);`);
    expect(stored.status).toBe("failed");
    expect(text).not.toContain(GH);
    expect(text).not.toContain(BOARD_KEY);
  }, 30_000);

  it("masks shapes in a timed-out run's stored row", async () => {
    const { stored, text } = await runOnce(`${leak(BOARD_KEY)} setTimeout(() => {}, 20000);`, { timeoutSec: 2, graceSec: 1 });
    expect(["timed_out", "failed", "cancelled"]).toContain(stored.status);
    expect(text).not.toContain(BOARD_KEY);
  }, 40_000);

  it("masks shapes in a cancelled run's stored row", async () => {
    const { stored, text } = await runOnce(`${leak(BOARD_KEY)} setTimeout(() => {}, 20000);`, {}, async (run) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await heartbeatService(db).cancelRun(run.id);
    });
    expect(stored.status).toBe("cancelled");
    expect(text).not.toContain(BOARD_KEY);
  }, 40_000);

  it("masks the injected PAPERCLIP_API_KEY and gateway, JWT and GitHub shapes in the row and the log (SYNA-1586)", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "c".repeat(64));
    const keyFile = path.join(os.tmpdir(), `syna-1586-run-key-${randomUUID()}`);
    const gateway = `pcgw_${randomUUID()}.${"Fk3Gw".repeat(9)}`;
    const fineGrained = `github_pat_11${"FAKE0".repeat(4)}_${"f4keFineGrained".repeat(4)}`;
    const oauth = `gho_${"F4ke0Tok3n".repeat(4)}`;
    try {
      // The process records its real run key in a private file for the assertion, then prints it the ways agents do.
      const script = [
        `const key = process.env.PAPERCLIP_API_KEY ?? "";`,
        `require("node:fs").writeFileSync(${JSON.stringify(keyFile)}, key);`,
        `console.log("env PAPERCLIP_API_KEY=" + key + " node agent.js");`,
        `console.log(JSON.stringify({ PAPERCLIP_API_KEY: key }));`,
        `console.error("bare " + key);`,
        leak(`${gateway} ${fineGrained} ${oauth}`),
      ].join(" ");
      const { stored, text } = await runOnce(script);
      const key = await fs.readFile(keyFile, "utf8");
      expect(stored.status).toBe("succeeded");
      expect(key.length).toBeGreaterThan(20);
      for (const value of [key, gateway, fineGrained, oauth]) expect(text).not.toContain(value);
      expect(text).toContain("PAPERCLIP_API_KEY");
    } finally {
      await fs.rm(keyFile, { force: true });
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "");
    }
  }, 30_000);

  it("masks a value registered for the run while it runs (no known shape)", async () => {
    const script = `setTimeout(() => { ${leak(`opaque ${REGISTERED} done`)} }, 4000);`;
    const { stored, text } = await runOnce(script, {}, async (run) => {
      // As in production: the agent reads the secret through the secrets route after its process started, so after
      // the run context is written. Wait for the process id first.
      for (let i = 0; i < 100; i++) {
        const row = await db.select({ pid: heartbeatRuns.processPid }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((rows) => rows[0]);
        if (row?.pid) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await createRunSecretRedactionRegistry(db).register(run.companyId, run.id, REGISTERED);
    });
    expect(stored.status).toBe("succeeded");
    expect(text).not.toContain(REGISTERED);
    expect(text).toContain("opaque");
  }, 30_000);
});
