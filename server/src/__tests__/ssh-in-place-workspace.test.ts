import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile, symlink, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshCommandResult,
  type SshConnectionConfig,
} from "@paperclipai/adapter-utils/ssh";
import {
  acquireSshInPlaceWorktreeLock,
  buildSshInPlaceRuntimeRoot,
  canonicalSshInPlaceLockKey,
  decideSshInPlaceRealization,
  probeSshInPlaceWorkspace,
  readSshInPlaceEnvironmentAllowlist,
  readSshInPlaceLockWaitMs,
  readSshInPlaceWorktreeLockHolder,
  releaseSshInPlaceWorktreeLocksForLease,
  SSH_IN_PLACE_ENVIRONMENTS_ENV,
  SSH_IN_PLACE_LOCK_WAIT_MS_ENV,
} from "../services/ssh-in-place-workspace.ts";

const execFileAsync = promisify(execFile);
const sshFixtureSupport = await getSshEnvLabSupport();

const fakeConfig: SshConnectionConfig = {
  host: "same-host.test",
  port: 22,
  username: "paperclip",
  remoteWorkspacePath: "/unused",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

/** Run the probe script with local bash: the "host" shares this disk. */
async function runLocally(_config: SshConnectionConfig, command: string): Promise<SshCommandResult> {
  const { stdout, stderr } = await execFileAsync("bash", ["-c", command]);
  return { stdout, stderr };
}

const tempRoots: string[] = [];
const heldLeases: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function leaseId(name: string) {
  const id = `${name}-${Math.random().toString(36).slice(2)}`;
  heldLeases.push(id);
  return id;
}

afterEach(async () => {
  for (const id of heldLeases.splice(0)) releaseSshInPlaceWorktreeLocksForLease(id);
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("SSH same-host in_place flag", () => {
  it("is off without the allowlist and parses a comma list", () => {
    expect(readSshInPlaceEnvironmentAllowlist({}).size).toBe(0);
    expect([...readSshInPlaceEnvironmentAllowlist({ [SSH_IN_PLACE_ENVIRONMENTS_ENV]: " env-a, ,env-b " })])
      .toEqual(["env-a", "env-b"]);
  });

  it("reads the lock wait with a safe default", () => {
    expect(readSshInPlaceLockWaitMs({})).toBe(30_000);
    expect(readSshInPlaceLockWaitMs({ [SSH_IN_PLACE_LOCK_WAIT_MS_ENV]: "500" })).toBe(500);
    expect(readSshInPlaceLockWaitMs({ [SSH_IN_PLACE_LOCK_WAIT_MS_ENV]: "nope" })).toBe(30_000);
  });

  it("puts the runtime root under the remote workspace path, per run", () => {
    expect(buildSshInPlaceRuntimeRoot("/home/u/work", "run-1")).toBe("/home/u/work/.paperclip-runtime/runs/run-1");
  });
});

describe("decideSshInPlaceRealization", () => {
  async function decide(input: {
    env?: NodeJS.ProcessEnv;
    adapterType?: string;
    localPath: string;
    remoteCwd: string;
    leaseId: string;
    runId?: string;
    runSsh?: typeof runLocally;
    isHolderActive?: () => Promise<boolean>;
    isHolderStopped?: () => Promise<boolean>;
  }) {
    let sshCalls = 0;
    const runSsh = input.runSsh ?? runLocally;
    const decision = await decideSshInPlaceRealization({
      environmentId: "env-1",
      adapterType: input.adapterType ?? "codex_local",
      localPath: input.localPath,
      remoteCwd: input.remoteCwd,
      leaseId: input.leaseId,
      runId: input.runId ?? "run-1",
      resolveConfig: async () => fakeConfig,
      isHolderActive: input.isHolderActive ?? (async () => true),
      isHolderStopped: input.isHolderStopped,
      env: input.env ?? { [SSH_IN_PLACE_ENVIRONMENTS_ENV]: "env-1", [SSH_IN_PLACE_LOCK_WAIT_MS_ENV]: "200" },
      lockPollMs: 20,
      runSsh: async (config, command) => {
        if (command.includes("canonical_directory")) return runLocally(config, command);
        sshCalls += 1;
        return runSsh(config, command);
      },
    });
    return { decision, sshCalls };
  }

  it("keeps the copy mode and makes no SSH call when the flag is off", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const { decision, sshCalls } = await decide({
      env: {},
      localPath: worktree,
      remoteCwd: remote,
      leaseId: leaseId("off"),
    });
    expect(decision).toEqual({ mode: "copy", reason: "flag_off", warn: false });
    expect(sshCalls).toBe(0);
  });

  it("keeps the copy mode for an adapter that does not honor in_place", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const { decision, sshCalls } = await decide({
      adapterType: "grok_local",
      localPath: worktree,
      remoteCwd: remote,
      leaseId: leaseId("grok"),
    });
    expect(decision).toMatchObject({ mode: "copy", warn: false });
    expect(sshCalls).toBe(0);
  });

  it("selects in_place when the host sees the same folder, and leaves no probe file", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    await writeFile(path.join(worktree, "README.md"), "hello\n");
    const id = leaseId("ok");
    const { decision, sshCalls } = await decide({ localPath: worktree, remoteCwd: remote, leaseId: id });
    expect(decision).toEqual({
      mode: "in_place",
      authoritativeRoot: worktree,
      runtimeRoot: path.posix.join(remote, ".paperclip-runtime", "runs", "run-1"),
    });
    expect(sshCalls).toBe(1);
    expect(await readdir(worktree)).toEqual(["README.md"]);
    expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))?.leaseId).toBe(id);
  });

  it("falls back to copy with a warning when the host path is missing", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const id = leaseId("missing");
    const { decision } = await decide({
      localPath: worktree,
      remoteCwd: remote,
      leaseId: id,
      runSsh: async () => ({ stdout: "host_missing\n", stderr: "" }),
    });
    expect(decision).toMatchObject({ mode: "copy", warn: true });
    expect((decision as { reason: string }).reason).toMatch(/^host_missing/);
    // A failed probe frees the lock at once.
    expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))).toBeNull();
  });

  it("falls back to copy when the host sees a different folder with the same path", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const { decision } = await decide({
      localPath: worktree,
      remoteCwd: remote,
      leaseId: leaseId("mismatch"),
      // The host has the folder but not the server's probe token.
      runSsh: async (config, command) => runLocally(config, command.replace(/\.paperclip-in-place-probe-/g, ".other-")),
    });
    expect(decision).toMatchObject({ mode: "copy", warn: true });
    expect((decision as { reason: string }).reason).toMatch(/^host_path_mismatch/);
  });

  it("falls back to copy when the SSH call fails", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const { decision } = await decide({
      localPath: worktree,
      remoteCwd: remote,
      leaseId: leaseId("ssh-error"),
      runSsh: async () => {
        throw new Error("ssh: connect to host same-host.test port 22: Connection refused");
      },
    });
    expect(decision).toMatchObject({ mode: "copy", warn: true });
    expect((decision as { reason: string }).reason).toMatch(/^probe_failed: ssh: connect/);
    expect(await readdir(worktree)).toEqual([]);
  });

  it("falls back to copy when the server worktree path does not exist", async () => {
    const remote = await makeTempDir("in-place-remote-");
    const { decision, sshCalls } = await decide({
      localPath: path.join(remote, "no-such-worktree"),
      remoteCwd: remote,
      leaseId: leaseId("local-missing"),
    });
    expect(decision).toMatchObject({ mode: "copy", warn: true });
    expect((decision as { reason: string }).reason).toMatch(/^local_missing/);
    expect(sshCalls).toBe(0);
  });

  it("falls back to copy when the runtime root would sit inside the worktree", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const { decision } = await decide({ localPath: worktree, remoteCwd: worktree, leaseId: leaseId("inside") });
    expect(decision).toEqual({ mode: "copy", reason: "runtime_root_inside_worktree", warn: true });
  });

  it("rejects a runtime base that aliases the worktree through a symlink", async () => {
    const root = await makeTempDir("in-place-alias-");
    const worktree = path.join(root, "worktree");
    await mkdir(worktree);
    const alias = path.join(root, "alias");
    await symlink(worktree, alias);
    const { decision } = await decide({ localPath: worktree, remoteCwd: path.join(alias, "new-directory"),
      leaseId: leaseId("alias") });
    expect(decision).toEqual({ mode: "copy", reason: "runtime_root_inside_worktree", warn: true });
    expect(await readdir(worktree)).toEqual([]);
  });

  it("checks aliases in an existing runtime ancestor", async () => {
    const root = await makeTempDir("in-place-ancestor-");
    const worktree = path.join(root, "worktree");
    const remote = path.join(root, "remote");
    await mkdir(worktree);
    await mkdir(remote);
    await symlink(worktree, path.join(remote, ".paperclip-runtime"));
    const { decision } = await decide({ localPath: worktree, remoteCwd: remote,
      leaseId: leaseId("ancestor") });
    expect(decision).toEqual({ mode: "copy", reason: "runtime_root_inside_worktree", warn: true });
  });

  it("makes a second run wait for the lock, then use the copy mode", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const first = await decide({ localPath: worktree, remoteCwd: remote, leaseId: leaseId("first"), runId: "run-1" });
    expect(first.decision.mode).toBe("in_place");

    const startedAt = Date.now();
    const second = await decide({ localPath: worktree, remoteCwd: remote, leaseId: leaseId("second"), runId: "run-2" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(second.decision).toEqual({ mode: "copy", reason: "worktree_busy:run-1", warn: true });
    expect(second.sshCalls).toBe(0);
  });

  it("gives the lock to a waiting run when the first lease is released", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    const firstLease = leaseId("first");
    await decide({ localPath: worktree, remoteCwd: remote, leaseId: firstLease, runId: "run-1" });
    const waiting = decide({
      env: { [SSH_IN_PLACE_ENVIRONMENTS_ENV]: "env-1", [SSH_IN_PLACE_LOCK_WAIT_MS_ENV]: "5000" },
      localPath: worktree,
      remoteCwd: remote,
      leaseId: leaseId("second"),
      runId: "run-2",
    });
    setTimeout(() => releaseSshInPlaceWorktreeLocksForLease(firstLease), 50);
    const second = await waiting;
    expect(second.decision).toMatchObject({ mode: "in_place", authoritativeRoot: worktree });
  });

  it("requires termination evidence before replacing an inactive holder", async () => {
    const worktree = await makeTempDir("in-place-worktree-");
    const remote = await makeTempDir("in-place-remote-");
    await decide({ localPath: worktree, remoteCwd: remote, leaseId: leaseId("stale"), runId: "run-1" });
    const id = leaseId("fresh");
    const second = await decide({
      localPath: worktree,
      remoteCwd: remote,
      leaseId: id,
      runId: "run-2",
      isHolderActive: async () => false,
      isHolderStopped: async () => true,
    });
    expect(second.decision.mode).toBe("in_place");
    expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))?.leaseId).toBe(id);
  });

  it("re-enters the lock for the same lease", async () => {
    const key = await canonicalSshInPlaceLockKey(await makeTempDir("in-place-reentry-"));
    const result = await acquireSshInPlaceWorktreeLock({
      key,
      leaseId: leaseId("same"),
      runId: "run-1",
      waitMs: 0,
      isHolderActive: async () => true,
    });
    expect(result.acquired).toBe(true);
    const again = await acquireSshInPlaceWorktreeLock({
      key,
      leaseId: heldLeases[heldLeases.length - 1]!,
      runId: "run-1",
      waitMs: 0,
      isHolderActive: async () => true,
    });
    expect(again.acquired).toBe(true);
  });
});

describe("probeSshInPlaceWorkspace on the SSH fixture", () => {
  const fixtureRoots: string[] = [];
  afterEach(async () => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("proves that a loopback SSH host sees the same folder", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(`Skipping SSH fixture probe test: ${sshFixtureSupport.reason ?? "unsupported environment"}`);
      return;
    }
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-in-place-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    const config = await buildSshEnvLabFixtureConfig(fixture);
    const worktree = await makeTempDir("in-place-fixture-worktree-");
    await execFileAsync("git", ["init", "-q", worktree]);

    expect(await probeSshInPlaceWorkspace({ config, localPath: worktree })).toEqual({ ok: true });
    expect((await readdir(worktree)).filter((name) => name.startsWith(".paperclip-in-place-probe-"))).toEqual([]);
    expect(await probeSshInPlaceWorkspace({ config, localPath: path.join(worktree, "missing") }))
      .toMatchObject({ ok: false, reason: "local_missing" });
  });
});
