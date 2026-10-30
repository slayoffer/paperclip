import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { buildSshEnvLabFixtureConfig, buildSshSpawnTarget, getSshEnvLabSupport,
  startSshEnvLabFixture, stopSshEnvLabFixture } from "@paperclipai/adapter-utils/ssh";
import { stopSshInPlaceWritersForRestart } from "../services/ssh-in-place-termination.js";
import { createSshEnvironmentDriver } from "../services/environment-ssh-driver.js";
import { releaseSshInPlaceWorktreeLocksForLease, SSH_IN_PLACE_ENVIRONMENTS_ENV,
  SSH_IN_PLACE_LOCK_WAIT_MS_ENV } from "../services/ssh-in-place-workspace.js";

// SYNA-2959: a restart must stop the run's remote writer and prove it, so the local SSH client exits with the
// provider's own status instead of being killed by signal (run 87699d0e was reaped for lack of that proof).
const { getById, releaseLease, updateLeaseMetadata } = vi.hoisted(() => ({
  getById: vi.fn(), releaseLease: vi.fn(), updateLeaseMetadata: vi.fn() }));
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ getById, releaseLease, updateLeaseMetadata }) }));
// Replace secret resolution with fixture authentication. Transport and process checks remain real.
vi.mock("../services/environment-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: unknown, environment: Environment) =>
    ({ driver: "ssh", config: environment.config }),
}));
const support = await getSshEnvLabSupport();
const containmentSupported = await promisify(execFile)("systemd-run", ["--user", "--scope", "--quiet", "--expand-environment=no", "true"], {
  env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` },
}).then(() => true, () => false);
const roots: string[] = [];
const leases: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const id of leases.splice(0)) releaseSshInPlaceWorktreeLocksForLease(id);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(!support.supported || !containmentSupported)("stops a live SSH writer for restart and the SSH client exits with a status", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-restart-stop-")));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(worktree);
  const fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh", "state.json") });
  const config = await buildSshEnvLabFixtureConfig(fixture);
  const environment = { id: randomUUID(), companyId: randomUUID(), driver: "ssh", config } as unknown as Environment;
  vi.stubEnv(SSH_IN_PLACE_ENVIRONMENTS_ENV, environment.id);
  vi.stubEnv(SSH_IN_PLACE_LOCK_WAIT_MS_ENV, "0");
  getById.mockResolvedValue(environment);
  let stored = { id: randomUUID(), companyId: environment.companyId, environmentId: environment.id,
    heartbeatRunId: randomUUID(), issueId: null, provider: "ssh",
    providerLeaseId: `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`,
    status: "active", releasedAt: null, cleanupStatus: null,
    metadata: { remoteCwd: config.remoteWorkspacePath, remoteWorkspacePath: config.remoteWorkspacePath },
  } as unknown as EnvironmentLease;
  leases.push(stored.id);
  updateLeaseMetadata.mockImplementation(async (_id, metadata) => (stored = { ...stored, metadata }));
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === heartbeatRuns ? [{ status: "running" }] : [stored],
  }) }) }) } as unknown as Db;
  const run = { id: stored.heartbeatRunId!, companyId: stored.companyId };
  await createSshEnvironmentDriver(db).realizeWorkspace!({ environment, lease: stored,
    workspace: { localPath: worktree, metadata: { workspaceRealizationRequest: { adapterType: "codex_local" } } } });

  // The 87699d0e shape: a provider that keeps running until something stops it.
  const target = await buildSshSpawnTarget({ spec: { ...config, remoteCwd: worktree }, command: "sleep", args: ["300"],
    env: { PAPERCLIP_RUN_ID: run.id } });
  const child = spawn(target.command, target.args, { stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    const writers = path.join(config.remoteWorkspacePath, ".paperclip-runtime", "ssh-writers", run.id);
    await expect.poll(() => readdir(writers).then(x => x.length, () => 0), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await stopSshInPlaceWritersForRestart(db, run, 3)).toBe(true);
    const [code, signal] = await exited;
    expect(signal).toBeNull();
    expect(typeof code).toBe("number");
    // A second stop finds nothing running and still proves the stop.
    expect(await stopSshInPlaceWritersForRestart(db, run, 3)).toBe(true);
    // Another endpoint cannot prove anything about this run.
    getById.mockResolvedValue({ ...environment, config: { ...config, port: Number(config.port) + 1 } });
    expect(await stopSshInPlaceWritersForRestart(db, run, 3)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await target.cleanup();
    await stopSshEnvLabFixture(fixture);
  }
}, 60_000);
