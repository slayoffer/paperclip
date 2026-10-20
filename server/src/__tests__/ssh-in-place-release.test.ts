import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  buildSshEnvLabFixtureConfig, buildSshSpawnTarget, getSshEnvLabSupport,
  startSshEnvLabFixture, stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { sshInPlaceLockChecks } from "../services/ssh-in-place-lock-checks.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import {
  decideSshInPlaceRealization, readSshInPlaceWorktreeLockHolder,
  releaseSshInPlaceWorktreeLocksForLease,
  SSH_IN_PLACE_ENVIRONMENTS_ENV, SSH_IN_PLACE_LOCK_WAIT_MS_ENV,
} from "../services/ssh-in-place-workspace.js";

const releaseLease = vi.hoisted(() => vi.fn());
vi.mock("../services/environments.js", () => ({ environmentService: () => ({ releaseLease }) }));
const support = await getSshEnvLabSupport();
const roots: string[] = [];
const leases: string[] = [];

afterEach(async () => {
  releaseLease.mockReset();
  for (const lease of leases.splice(0)) releaseSshInPlaceWorktreeLocksForLease(lease);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.skipIf(!support.supported)("keeps ownership after SSH disconnect while its writer continues", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-in-place-disconnect-")));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  await mkdir(worktree);
  const fixture = await startSshEnvLabFixture({ statePath: path.join(root, "ssh", "state.json") });
  const config = await buildSshEnvLabFixtureConfig(fixture);
  const lease = {
    id: randomUUID(), companyId: randomUUID(), heartbeatRunId: randomUUID(),
    provider: "ssh", providerLeaseId: `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`,
    status: "active", releasedAt: null, cleanupStatus: null, metadata: {},
  } as EnvironmentLease;
  leases.push(lease.id);
  let stored = lease;
  // Substitute only database access. The driver, receipt check, realization,
  // lock files, SSH transport, and remote writer all use production code.
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [stored] }) }) }) } as unknown as Db;
  const driver = environmentRuntimeService(db).getDriver("ssh")!;
  const decide = async (id: string) => {
    leases.push(id);
    return decideSshInPlaceRealization({
      environmentId: "env", adapterType: "codex_local", localPath: worktree,
      remoteCwd: config.remoteWorkspacePath, leaseId: id, runId: id === lease.id ? lease.heartbeatRunId : randomUUID(),
      env: { [SSH_IN_PLACE_ENVIRONMENTS_ENV]: "env", [SSH_IN_PLACE_LOCK_WAIT_MS_ENV]: "0" },
      resolveConfig: async () => config, ...sshInPlaceLockChecks(db, lease.companyId),
    });
  };
  const output = path.join(worktree, "writes");
  const pidFile = path.join(root, "writer.pid");
  let writerPid: number | undefined;
  let ssh: ReturnType<typeof spawn> | undefined;
  let cleanupTarget: (() => Promise<void>) | undefined;
  try {
    expect(await decide(lease.id)).toMatchObject({ mode: "in_place" });
    const source = path.join(root, "writer.cjs");
    await writeFile(source, `const fs = require('node:fs');
      process.on('SIGHUP', () => {});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'x'), 20);
    `);
    const target = await buildSshSpawnTarget({
      spec: { ...config, remoteCwd: worktree }, command: process.execPath, args: [source], env: {},
    });
    cleanupTarget = target.cleanup;
    ssh = spawn(target.command, target.args, { stdio: "ignore" });
    const sshExit = once(ssh, "exit");
    await expect.poll(async () => {
      try { return (await readFile(output, "utf8")).length; } catch { return 0; }
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    writerPid = Number(await readFile(pidFile, "utf8"));
    const before = (await readFile(output, "utf8")).length;
    ssh.kill("SIGKILL");
    await sshExit;
    await expect.poll(async () => (await readFile(output, "utf8")).length).toBeGreaterThan(before);
    process.kill(writerPid, 0);

    for (const status of ["failed", "expired", "released"] as const) {
      releaseLease.mockImplementation(async () => (stored = { ...lease, status, releasedAt: new Date() }));
      await driver.releaseRunLease({ environment: { driver: "ssh" } as Environment, lease, status });
      expect(readSshInPlaceWorktreeLockHolder(worktree)?.leaseId).toBe(lease.id);
      expect(await decide(randomUUID())).toMatchObject({ mode: "copy", reason: expect.stringContaining("worktree_busy:") });
    }
    releaseLease.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(driver.releaseRunLease({ environment: { driver: "ssh" } as Environment, lease, status: "failed" }))
      .rejects.toThrow("database unavailable");
    expect(await decide(randomUUID())).toMatchObject({ mode: "copy" });
    const later = (await readFile(output, "utf8")).length;
    await expect.poll(async () => (await readFile(output, "utf8")).length).toBeGreaterThan(later);
    console.info("SSH client exited. The remote writer remains active. Replacement mode=copy for every release status.");

    // Terminate the actual writer before the fixture supplies a provider receipt.
    process.kill(writerPid, "SIGTERM");
    await expect.poll(async () => {
      try { process.kill(writerPid!, 0); return false; } catch { return true; }
    }).toBe(true);
    writerPid = undefined;
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" })!;
    stored = { ...stored, cleanupStatus: "success", metadata: { remoteExecutionTermination: { ...receipt, runId: randomUUID() } } };
    expect(await decide(randomUUID())).toMatchObject({ mode: "copy" });
    stored = { ...stored, metadata: { remoteExecutionTermination: receipt } };
    expect(await decide(randomUUID())).toMatchObject({ mode: "in_place" });
  } finally {
    if (writerPid) { try { process.kill(writerPid, "SIGTERM"); } catch { /* Already stopped. */ } }
    if (ssh?.exitCode === null && ssh.signalCode === null) ssh.kill("SIGKILL");
    await cleanupTarget?.();
    await stopSshEnvLabFixture(fixture);
  }
}, 45_000);
