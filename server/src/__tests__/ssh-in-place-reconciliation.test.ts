import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, projects,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { buildSshEnvLabFixtureConfig, buildSshSpawnTarget, getSshEnvLabSupport,
  startSshEnvLabFixture, stopSshEnvLabFixture } from "@paperclipai/adapter-utils/ssh";
import { sshWriterDirectory } from "@paperclipai/adapter-utils/ssh-writer-termination";
import { createSshInPlaceOwnershipReconciler } from "../services/ssh-in-place-reconciliation.js";
import { createSshEnvironmentDriver } from "../services/environment-ssh-driver.js";
import { acquireSshInPlaceWorktreeLock, readSshInPlaceWorktreeLockHolder,
  releaseSshInPlaceWorktreeLocksForLease } from "../services/ssh-in-place-lock.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { logger } from "../middleware/logger.js";
import * as leaseServices from "../services/environments.js";
import * as ownership from "../services/ssh-in-place-lock.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Only secret resolution uses fixture authentication. SQL, SSH, remote process
// checks, receipt persistence, ownership files, and realization remain real.
vi.mock("../services/environment-config.js", async (original) => ({
  ...await original<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: unknown, environment: Environment) =>
    ({ driver: "ssh", config: environment.config }),
}));
const sshSupport = await getSshEnvLabSupport();
const pgSupport = await getEmbeddedPostgresTestSupport();
if (process.env.PAPERCLIP_REQUIRE_WRITER_CONTAINMENT_TESTS === "1" && (!sshSupport.supported || !pgSupport.supported)) {
  throw new Error("Ownership reconciliation tests require SSH and PostgreSQL");
}
describe.skipIf(!sshSupport.supported || !pgSupport.supported)("SSH ownership reconciliation", () => {
  let db: ReturnType<typeof createDb>;
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof startSshEnvLabFixture>>;
  let config: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>;
  let root: string;
  const companyIds: string[] = [];
  const environmentIds: string[] = [];
  const leaseIds: string[] = [];
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-owner-reconcile-")));
    fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh", "state.json") });
    config = await buildSshEnvLabFixtureConfig(fixture);
    postgres = await startEmbeddedPostgresTestDatabase("paperclip-ssh-reconcile-");
    db = createDb(postgres.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    for (const id of leaseIds.splice(0)) releaseSshInPlaceWorktreeLocksForLease(id);
    if (companyIds.length) {
      const ids = companyIds.splice(0);
      await db.delete(environmentLeases).where(inArray(environmentLeases.companyId, ids));
      await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, ids));
      await db.delete(executionWorkspaces).where(inArray(executionWorkspaces.companyId, ids));
      await db.delete(projects).where(inArray(projects.companyId, ids));
      await db.delete(agents).where(inArray(agents.companyId, ids));
      await db.delete(companies).where(inArray(companies.id, ids));
    }
    if (environmentIds.length) await db.delete(environments).where(inArray(environments.id, environmentIds.splice(0)));
  });
  afterAll(async () => {
    await db?.$client.end(); await postgres?.cleanup();
    if (fixture) await stopSshEnvLabFixture(fixture);
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function owner(input: { status?: string; tracking?: boolean; leaseId?: string; writerDirectory?: boolean } = {}) {
    const companyId = randomUUID(); companyIds.push(companyId);
    await db.insert(companies).values({ id: companyId, name: "Owner recovery", issuePrefix: `R${companyId.slice(0, 7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Recovery" }).returning();
    const cwd = path.join(root, randomUUID()); await mkdir(cwd);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Writer", cwd }).returning();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "ssh", config }).returning();
    environmentIds.push(environment.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      invocationSource: "on_demand", status: input.status ?? "succeeded" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ id: input.leaseId, companyId,
      environmentId: environment.id, executionWorkspaceId: workspace.id, heartbeatRunId: run.id,
      leasePolicy: "ephemeral", provider: "ssh", status: "released", releasedAt: new Date(),
      providerLeaseId: `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`,
      metadata: { remoteCwd: config.remoteWorkspacePath, remoteWorkspacePath: config.remoteWorkspacePath,
        ...(input.tracking ? { sshInPlaceWriter: { key: cwd, remoteCwd: config.remoteWorkspacePath } } : {}) },
    }).returning();
    leaseIds.push(lease.id);
    await acquireSshInPlaceWorktreeLock({ key: cwd, leaseId: lease.id, runId: run.id, waitMs: 0, isHolderActive: async () => true });
    const directory = sshWriterDirectory(config.remoteWorkspacePath, run.id);
    if (input.writerDirectory !== false) await mkdir(directory, { recursive: true });
    return { companyId, environment, run, lease, cwd, directory };
  }
  async function stoppedWriter(f: Awaited<ReturnType<typeof owner>>) {
    const target = await buildSshSpawnTarget({ spec: { ...config, remoteCwd: f.cwd }, command: "true",
      args: [], env: { PAPERCLIP_RUN_ID: f.run.id } });
    try {
      const child = spawn(target.command, target.args, { stdio: "ignore" });
      expect((await once(child, "exit"))[0]).toBe(0);
    } finally { await target.cleanup(); }
  }
  async function stored(id: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0] as EnvironmentLease;
  }
  it.each([false, true])("recovers terminal ownership with saved tracking %s and logs the next realization in place", async tracking => {
    const f = await owner({ tracking }); await stoppedWriter(f);
    if (tracking) await db.update(environmentLeases).set({ status: "active", releasedAt: null })
      .where(eq(environmentLeases.id, f.lease.id));
    expect(await createSshInPlaceOwnershipReconciler(db)()).toEqual({ scanned: 1, released: 1 });
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.run.agentId,
      invocationSource: "on_demand", status: "running" }).returning();
    const [next] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
      heartbeatRunId: nextRun.id, provider: "ssh", providerLeaseId: f.lease.providerLeaseId,
      metadata: { remoteCwd: config.remoteWorkspacePath, remoteWorkspacePath: config.remoteWorkspacePath },
    }).returning(); leaseIds.push(next.id);
    vi.stubEnv("PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS", f.environment.id);
    vi.stubEnv("PAPERCLIP_SSH_IN_PLACE_LOCK_WAIT_MS", "0");
    const info = vi.spyOn(logger, "info");
    const result = await createSshEnvironmentDriver(db).realizeWorkspace!({ environment: f.environment as Environment,
      lease: next as EnvironmentLease, workspace: { localPath: f.cwd,
        metadata: { workspaceRealizationRequest: { adapterType: "codex_local" } } } });
    expect(result.cwd).toBe(f.cwd);
    expect(info.mock.calls.some(call => call[1] === "SSH workspace realized in place on the shared host path")).toBe(true);
  });
  it.each(["queued", "running"])("preserves an owner whose run status is %s", async status => {
    const f = await owner({ status }); await stoppedWriter(f);
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
  });
  it("releases interrupted ownership after the contained writer stops", async () => {
    const f = await owner({ status: "interrupted", tracking: true }); await stoppedWriter(f);
    expect(await createSshInPlaceOwnershipReconciler(db)()).toEqual({ scanned: 1, released: 1 });
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
  });
  it.each(["cancelled", "failed"])("releases a %s owner without a writer directory", async status => {
    const f = await owner({ status, tracking: true, writerDirectory: false });
    await expect(readdir(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await createSshInPlaceOwnershipReconciler(db)()).toEqual({ scanned: 1, released: 1 });
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
  });
  it.each(["queued", "running"])("preserves a %s owner without a writer directory", async status => {
    const f = await owner({ status, tracking: true, writerDirectory: false });
    expect(await createSshInPlaceOwnershipReconciler(db)()).toEqual({ scanned: 0, released: 0 });
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
  });
  it("preserves live PIDs, missing identities, and changed SSH endpoints", async () => {
    const live = await owner(); await stoppedWriter(live);
    const names = await readdir(live.directory);
    const marker = path.join(live.directory, names[0]);
    const identity = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...identity, pid: process.pid }));
    const missing = await owner();
    const changed = await owner(); await stoppedWriter(changed);
    await db.update(environments).set({ config: { ...config, port: 1 } }).where(eq(environments.id, changed.environment.id));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    for (const f of [live, missing, changed]) {
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
      expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
    }
  });
  it.each([0, -1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1])("preserves an invalid remote PID %s", async pid => {
    const f = await owner(); await stoppedWriter(f);
    const marker = path.join(f.directory, (await readdir(f.directory))[0]);
    const identity = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...identity, pid }));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
  });
  it("preserves ownership when SSH cannot check the original endpoint", async () => {
    const f = await owner(); await stoppedWriter(f);
    await db.update(environments).set({ config: { ...config, port: 1 } }).where(eq(environments.id, f.environment.id));
    await db.update(environmentLeases).set({ providerLeaseId:
      `ssh://${config.username}@${config.host}:1${config.remoteWorkspacePath}` }).where(eq(environmentLeases.id, f.lease.id));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
  });
  it("preserves ownership after a receipt write failure and retries later", async () => {
    const f = await owner(); await stoppedWriter(f);
    const original = leaseServices.environmentService;
    const injected = vi.spyOn(leaseServices, "environmentService").mockImplementation((...args) => ({
      ...original(...args), releaseLease: vi.fn().mockRejectedValue(new Error("Injected database write failure")),
    }));
    const sweep = createSshInPlaceOwnershipReconciler(db);
    expect((await sweep()).released).toBe(0);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
    injected.mockRestore();
    expect((await sweep()).released).toBe(1);
  });
  it("recovers a persisted receipt after interrupted file release without a new remote probe", async () => {
    const f = await owner(); await stoppedWriter(f);
    const injected = vi.spyOn(ownership, "releaseConfirmedSshInPlaceWorktreeLock").mockReturnValue(false);
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
    injected.mockRestore();
    await db.update(environments).set({ config: { ...config, port: 1 } }).where(eq(environments.id, f.environment.id));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(1);
  });
  it("accepts earlier verified containment records without a PID", async () => {
    const f = await owner(); await stoppedWriter(f);
    const marker = path.join(f.directory, (await readdir(f.directory))[0]);
    const identity = JSON.parse(await readFile(marker, "utf8")); delete identity.pid;
    await writeFile(marker, JSON.stringify(identity));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(1);
  });
  it("retains detached descendants after the recorded remote PID exits", async () => {
    const f = await owner();
    const stop = path.join(f.cwd, "stop");
    const ready = path.join(f.cwd, "ready");
    const detached = "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 20); setTimeout(() => clearInterval(timer), 15000).unref();";
    const launcher = "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }); child.unref();";
    const target = await buildSshSpawnTarget({ spec: { ...config, remoteCwd: f.cwd }, command: "node",
      args: ["-e", launcher, detached, stop, ready], env: { PAPERCLIP_RUN_ID: f.run.id } });
    const child = spawn(target.command, target.args, { stdio: "ignore" }); const exit = once(child, "exit");
    try {
      expect((await exit)[0]).toBe(0);
      await expect.poll(() => readFile(ready, "utf8").then(Number, () => 0)).toBeGreaterThan(0);
      expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
    } finally { await writeFile(stop, "stop"); await exit; await target.cleanup(); }
  });
  it("preserves malformed records and old records without verified containment", async () => {
    const f = await owner();
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!; await once(child, "exit");
    for (const record of ["uncontained", `${boot}\n${pid}\n`, JSON.stringify({ version: 2, pid })]) {
      await writeFile(path.join(f.directory, "00000000-0000-4000-8000-000000000000"), record);
      expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
    }
  });
  it("refuses cross-company run associations and mismatched ownership identities", async () => {
    const f = await owner(); const other = await owner();
    await stoppedWriter(f); await stoppedWriter(other);
    await db.update(environmentLeases).set({ heartbeatRunId: other.run.id }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ metadata: { ...other.lease.metadata,
      sshInPlaceWriter: { key: f.cwd, remoteCwd: config.remoteWorkspacePath } } }).where(eq(environmentLeases.id, other.lease.id));
    expect((await createSshInPlaceOwnershipReconciler(db)()).released).toBe(0);
    expect(hasRemoteTerminationReceipt(await stored(f.lease.id))).toBe(false);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
  });
  it("advances beyond one page of uncertain owners", async () => {
    const f = await owner({ leaseId: "00000000-0000-4000-8000-000000000021" });
    await stoppedWriter(f);
    for (let i = 1; i <= 20; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await db.insert(environmentLeases).values({ ...f.lease, id, heartbeatRunId: f.run.id, metadata: {} });
    }
    const sweep = createSshInPlaceOwnershipReconciler(db);
    expect(await sweep()).toEqual({ scanned: 20, released: 0 });
    expect(await sweep()).toEqual({ scanned: 1, released: 1 });
    expect(await sweep()).toEqual({ scanned: 20, released: 0 });
  });
});
