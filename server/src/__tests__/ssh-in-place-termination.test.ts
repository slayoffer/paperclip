import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { buildSshEnvLabFixtureConfig, buildSshSpawnTarget, getSshEnvLabSupport,
  startSshEnvLabFixture, stopSshEnvLabFixture } from "@paperclipai/adapter-utils/ssh";
import { createSshEnvironmentDriver } from "../services/environment-ssh-driver.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { logger } from "../middleware/logger.js";
import { readSshInPlaceWorktreeLockHolder, releaseSshInPlaceWorktreeLocksForLease,
  SSH_IN_PLACE_ENVIRONMENTS_ENV, SSH_IN_PLACE_LOCK_WAIT_MS_ENV } from "../services/ssh-in-place-workspace.js";

const { releaseLease, updateLeaseMetadata } = vi.hoisted(() => ({ releaseLease: vi.fn(), updateLeaseMetadata: vi.fn() }));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ releaseLease, updateLeaseMetadata }) }));
// Replace secret resolution with fixture authentication. Transport and process checks remain real.
vi.mock("../services/environment-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: unknown, environment: Environment) =>
    ({ driver: "ssh", config: environment.config }),
}));
const support = await getSshEnvLabSupport();
const roots: string[] = [];
const leases: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  releaseLease.mockReset();
  updateLeaseMetadata.mockReset();
  for (const id of leases.splice(0)) releaseSshInPlaceWorktreeLocksForLease(id);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(!support.supported || process.platform !== "linux")("realizes consecutive runs in place and recovers terminal ownership after a disconnect", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-receipt-")));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(worktree);
  const fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh", "state.json") });
  const config = await buildSshEnvLabFixtureConfig(fixture);
  const environment = { id: randomUUID(), companyId: randomUUID(), driver: "ssh", config } as unknown as Environment;
  vi.stubEnv(SSH_IN_PLACE_ENVIRONMENTS_ENV, environment.id);
  vi.stubEnv(SSH_IN_PLACE_LOCK_WAIT_MS_ENV, "0");
  const info = vi.spyOn(logger, "info");
  const stored = new Map<string, EnvironmentLease>();
  const terminal = new Set<string>();
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === heartbeatRuns ? [{ status: terminal.size ? "succeeded" : "running" }] : [...stored.values()].filter(x => readSshInPlaceWorktreeLockHolder(worktree)?.leaseId === x.id),
  }) }) }) } as unknown as Db;
  updateLeaseMetadata.mockImplementation(async (id, metadata) => {
    const row = { ...stored.get(id)!, metadata };
    stored.set(id, row);
    return row;
  });
  releaseLease.mockImplementation(async (id, status, options) => {
    const row = { ...stored.get(id)!, status, releasedAt: new Date(), cleanupStatus: options?.cleanupStatus ?? null,
      metadata: { ...stored.get(id)?.metadata, ...(options?.remoteExecutionTermination
        ? { remoteExecutionTermination: options.remoteExecutionTermination } : {}) } };
    stored.set(id, row);
    return row;
  });
  const driver = createSshEnvironmentDriver(db);
  const lease = () => {
    const row = { id: randomUUID(), companyId: environment.companyId, environmentId: environment.id,
      heartbeatRunId: randomUUID(), provider: "ssh",
      providerLeaseId: `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`,
      status: "active", releasedAt: null, cleanupStatus: null,
      metadata: { remoteCwd: config.remoteWorkspacePath, remoteWorkspacePath: config.remoteWorkspacePath },
    } as EnvironmentLease;
    leases.push(row.id);
    stored.set(row.id, row);
    return row;
  };
  const realize = (row: EnvironmentLease) => driver.realizeWorkspace!({ environment, lease: row,
    workspace: { localPath: worktree, metadata: { workspaceRealizationRequest: { adapterType: "codex_local" } } } });
  async function launch(row: EnvironmentLease, command: string, args: string[]) {
    const target = await buildSshSpawnTarget({ spec: { ...config, remoteCwd: worktree }, command, args,
      env: { PAPERCLIP_RUN_ID: row.heartbeatRunId! } });
    const child = spawn(target.command, target.args, { stdio: "ignore" });
    return { child, cleanup: target.cleanup, exited: once(child, "exit") };
  }
  let writerPid: number | undefined;
  let connection: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const row = lease();
      expect((await realize(row)).cwd).toBe(worktree);
      connection = await launch(row, "true", []);
      expect((await connection.exited)[0]).toBe(0);
      await connection.cleanup();
      const released = await driver.releaseRunLease({ environment, lease: stored.get(row.id)!, status: "released" });
      expect(hasRemoteTerminationReceipt(released!)).toBe(true);
      expect(readSshInPlaceWorktreeLockHolder(worktree)).toBeNull();
    }
    expect(info.mock.calls.filter(call => call[1] === "SSH workspace realized in place on the shared host path")).toHaveLength(2);
    const row = lease();
    await realize(row);
    const source = path.join(root, "writer.cjs");
    const pidFile = path.join(root, "writer.pid");
    const output = path.join(worktree, "writes");
    await writeFile(source, `const fs = require('node:fs'); process.on('SIGHUP', () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'x'), 20);`);
    connection = await launch(row, process.execPath, [source]);
    await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
    writerPid = Number(await readFile(pidFile, "utf8"));
    await expect.poll(() => readFile(output, "utf8").then(x => x.length, () => 0)).toBeGreaterThan(0);
    connection.child.kill("SIGKILL");
    await connection.exited;
    const before = (await readFile(output, "utf8")).length;
    await expect.poll(async () => (await readFile(output, "utf8")).length).toBeGreaterThan(before);
    terminal.add(row.heartbeatRunId!);
    // A terminal run with an active lease still cannot replace its live writer.
    const candidate = lease();
    await realize(candidate);
    expect(readSshInPlaceWorktreeLockHolder(worktree)?.leaseId).toBe(row.id);
    process.kill(writerPid, "SIGTERM");
    await expect.poll(() => { try { process.kill(writerPid!, 0); return false; } catch { return true; } }).toBe(true);
    writerPid = undefined;
    await realize(candidate);
    expect(hasRemoteTerminationReceipt(stored.get(row.id)!)).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(worktree)?.leaseId).toBe(candidate.id);
    console.info("Two consecutive runs realized in place. Dead terminal ownership recovered. Live disconnected writer retained ownership.");
  } finally {
    if (writerPid) { try { process.kill(writerPid, "SIGTERM"); } catch { /* Already stopped. */ } }
    if (connection?.child.exitCode === null && connection.child.signalCode === null) connection.child.kill("SIGKILL");
    await connection?.cleanup();
    await stopSshEnvLabFixture(fixture);
  }
}, 60_000);
