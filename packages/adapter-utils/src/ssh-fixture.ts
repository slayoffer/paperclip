import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type SshConnectionConfig, type SshEnvLabSupport, type SshEnvLabFixtureState } from "./ssh-config.js";
import { execFileText, commandExists, resolveCommandPath, ensureSshWorkspaceReady } from "./ssh-command.js";

async function allocateLoopbackPort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(
  fn: () => Promise<void>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? 10_000);
  const intervalMs = options.intervalMs ?? 200;
  let lastError: unknown = null;
  while (Date.now() < timeoutAt) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for SSH fixture readiness.");
}

async function isPidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  for (const format of ["command=", "args="]) {
    try {
      const result = await execFileText("ps", ["-o", format, "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      });
      const command = result.stdout.trim();
      if (command.length > 0) {
        return command;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function isSshEnvLabFixtureProcess(state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">): Promise<boolean> {
  if (!(await isPidRunning(state.pid))) {
    return false;
  }

  const command = await readProcessCommand(state.pid);
  if (!command) {
    return false;
  }

  return command.includes(state.sshdConfigPath);
}

export async function getSshEnvLabSupport(): Promise<SshEnvLabSupport> {
  if (process.platform === "darwin" && process.env.PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB !== "1") {
    return {
      supported: false,
      reason: "SSH env-lab fixture is disabled on macOS; set PAPERCLIP_ENABLE_DARWIN_SSH_ENV_LAB=1 to opt in.",
    };
  }

  for (const command of ["ssh", "sshd", "ssh-keygen"]) {
    if (!(await commandExists(command))) {
      return {
        supported: false,
        reason: `Missing required command: ${command}`,
      };
    }
  }

  return {
    supported: true,
    reason: null,
  };
}

export function buildKnownHostsEntry(input: {
  host: string;
  port: number;
  publicKey: string;
}): string {
  return `[${input.host}]:${input.port} ${input.publicKey.trim()}`;
}

const SSH_ENV_LAB_FIXTURE_PATH_FIELDS = [
  "rootDir",
  "workspaceDir",
  "statePath",
  "clientPrivateKeyPath",
  "clientPublicKeyPath",
  "hostPrivateKeyPath",
  "hostPublicKeyPath",
  "authorizedKeysPath",
  "knownHostsPath",
  "sshdConfigPath",
  "sshdLogPath",
] as const satisfies readonly (keyof SshEnvLabFixtureState)[];

// True when candidate is an absolute path equal to rootDir or nested under
// it. Used to reject a state file whose paths point outside the fixture
// root it was read from.
function isPathRootedAt(candidate: string, rootDir: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  if (candidate === rootDir) return true;
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// The state file is untrusted input: any local process running as the same
// user can write one. A forged pid or an empty sshdConfigPath would weaken
// isSshEnvLabFixtureProcess's identity check — an empty string is a
// substring of every command line, so it would match any running process.
// Reject a state file that fails this check before any identity check or
// signal runs against it.
function isValidSshEnvLabFixtureState(
  raw: SshEnvLabFixtureState,
  expectedRootDir: string,
): boolean {
  if (!Number.isSafeInteger(raw.pid) || raw.pid <= 0) return false;
  if (raw.rootDir !== expectedRootDir) return false;

  for (const field of SSH_ENV_LAB_FIXTURE_PATH_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || !isPathRootedAt(value, expectedRootDir)) {
      return false;
    }
  }

  const expectedSshdConfigPath = path.join(expectedRootDir, "sshd_config");
  if (raw.sshdConfigPath.length === 0 || raw.sshdConfigPath !== expectedSshdConfigPath) {
    return false;
  }

  return true;
}

export async function readSshEnvLabFixtureState(
  statePath: string,
): Promise<SshEnvLabFixtureState | null> {
  try {
    // Resolve a relative statePath against the current working directory
    // before use. The state validator below only accepts absolute paths, and
    // a relative statePath must resolve to the same absolute directory every
    // time a caller reads it, no matter the process working directory.
    const resolvedStatePath = path.resolve(statePath);
    const raw = JSON.parse(await fs.readFile(resolvedStatePath, "utf8")) as SshEnvLabFixtureState;
    if (!raw || raw.kind !== "ssh_openbsd") return null;
    if (!isValidSshEnvLabFixtureState(raw, path.dirname(resolvedStatePath))) return null;
    return raw;
  } catch {
    return null;
  }
}

async function waitUntilFixtureProcessExits(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs;
  while (true) {
    if (!(await isSshEnvLabFixtureProcess(state))) return true;
    if (Date.now() >= timeoutAt) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Sends a signal to a pid and treats an already-dead process as success.
// The identity check that runs before this call is not free: it spawns
// `ps`, which opens a real gap between the check and the signal. If the
// process exits inside that gap, `process.kill` throws ESRCH even though
// the outcome the caller wants (the process is gone) already holds. Any
// other error, such as EPERM for a pid that belongs to another user, must
// still propagate.
function signalFixtureProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

// Bounded shutdown escalation shared by every caller that must stop a
// fixture process: send SIGTERM, wait, re-check process identity (the pid
// can be reused in the gap between two signals), then SIGKILL, then wait
// again. Returns true only when the listener is confirmed gone.
async function escalateSshEnvLabFixtureShutdown(
  state: Pick<SshEnvLabFixtureState, "pid" | "sshdConfigPath">,
): Promise<boolean> {
  if (!(await isSshEnvLabFixtureProcess(state))) return true;

  if (!signalFixtureProcess(state.pid, "SIGTERM")) return true;
  if (await waitUntilFixtureProcessExits(state, 5_000)) return true;

  if (!(await isSshEnvLabFixtureProcess(state))) return true;
  if (!signalFixtureProcess(state.pid, "SIGKILL")) return true;
  if (await waitUntilFixtureProcessExits(state, 2_000)) return true;

  return !(await isSshEnvLabFixtureProcess(state));
}

// Accepts a state path or an already-read state so a caller that already
// holds the fixture state in memory does not have to depend on the state
// file, which a teardown step may have already removed.
export async function stopSshEnvLabFixture(
  stateOrPath: string | SshEnvLabFixtureState,
): Promise<boolean> {
  const state = typeof stateOrPath === "string"
    ? await readSshEnvLabFixtureState(stateOrPath)
    : stateOrPath;
  if (!state) return false;

  if (!(await escalateSshEnvLabFixtureShutdown(state))) {
    throw new Error(
      `SSH env-lab fixture did not stop: pid ${state.pid} on port ${state.port} is still running after SIGKILL.`,
    );
  }

  // Remove the root directory only after the listener process is confirmed
  // gone. Removing it earlier would delete the state file the process needs
  // for a later stop attempt to find and signal it.
  await fs.rm(state.rootDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function startSshEnvLabFixture(input: {
  statePath: string;
  bindHost?: string;
  host?: string;
  // Test-only. Shortens the readiness wait below its 10 second default, so
  // a regression test can force the start-failure cleanup path without a
  // real 10 second wait.
  readinessTimeoutMs?: number;
}): Promise<SshEnvLabFixtureState> {
  // Resolve a relative statePath against the current working directory once,
  // up front. Every derived path (rootDir and the persisted statePath field)
  // must be absolute, so the state validator in readSshEnvLabFixtureState
  // accepts the file that this function writes.
  const statePath = path.resolve(input.statePath);
  const existing = await readSshEnvLabFixtureState(statePath);
  if (existing && await isSshEnvLabFixtureProcess(existing)) {
    return existing;
  }
  if (existing) {
    await fs.rm(existing.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    throw new Error(`SSH env-lab fixture is unavailable: ${support.reason}`);
  }
  const sshdPath = await resolveCommandPath("sshd");
  if (!sshdPath) {
    throw new Error("SSH env-lab fixture is unavailable: missing required command: sshd");
  }

  const bindHost = input.bindHost ?? "127.0.0.1";
  const host = input.host ?? bindHost;
  const rootDir = path.dirname(statePath);
  await fs.mkdir(rootDir, { recursive: true });

  const username = os.userInfo().username;
  const port = await allocateLoopbackPort(bindHost);
  const workspaceDir = path.join(rootDir, "workspace");
  const clientPrivateKeyPath = path.join(rootDir, "client_key");
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const hostPrivateKeyPath = path.join(rootDir, "host_key");
  const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(rootDir, "authorized_keys");
  const knownHostsPath = path.join(rootDir, "known_hosts");
  const sshdConfigPath = path.join(rootDir, "sshd_config");
  const sshdLogPath = path.join(rootDir, "sshd.log");
  const sshdPidPath = path.join(rootDir, "sshd.pid");

  await fs.mkdir(workspaceDir, { recursive: true });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientPrivateKeyPath], {
    timeout: 15_000,
  });
  await execFileText("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  });

  await fs.copyFile(clientPublicKeyPath, authorizedKeysPath);
  const hostPublicKey = (await execFileText("ssh-keygen", ["-y", "-f", hostPrivateKeyPath], {
    timeout: 15_000,
  })).stdout.trim();
  await fs.writeFile(
    knownHostsPath,
    `${buildKnownHostsEntry({ host, port, publicKey: hostPublicKey })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    sshdConfigPath,
    [
      `Port ${port}`,
      `ListenAddress ${bindHost}`,
      `HostKey ${hostPrivateKeyPath}`,
      `PidFile ${sshdPidPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "PasswordAuthentication no",
      "ChallengeResponseAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM no",
      "StrictModes no",
      `AllowUsers ${username}`,
      "LogLevel VERBOSE",
      "PrintMotd no",
      "UseDNS no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const child = spawn(sshdPath, ["-D", "-f", sshdConfigPath, "-E", sshdLogPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const state: SshEnvLabFixtureState = {
    kind: "ssh_openbsd",
    bindHost,
    host,
    port,
    username,
    rootDir,
    workspaceDir,
    statePath,
    pid: child.pid ?? 0,
    createdAt: new Date().toISOString(),
    clientPrivateKeyPath,
    clientPublicKeyPath,
    hostPrivateKeyPath,
    hostPublicKeyPath,
    authorizedKeysPath,
    knownHostsPath,
    sshdConfigPath,
    sshdLogPath,
  };

  if (!state.pid) {
    throw new Error("Failed to start SSH env-lab fixture.");
  }

  try {
    await waitForCondition(async () => {
      if (!(await isPidRunning(state.pid))) {
        const logOutput = await fs.readFile(sshdLogPath, "utf8").catch(() => "");
        throw new Error(logOutput || "SSH env-lab fixture exited before becoming ready.");
      }
      const config = await buildSshEnvLabFixtureConfig(state);
      await ensureSshWorkspaceReady(config);
    }, { timeoutMs: input.readinessTimeoutMs ?? 10_000, intervalMs: 250 });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    // No state file exists on this path yet, so a later stopSshEnvLabFixture
    // call can never find this pid. Escalate and wait for exit here, the
    // same way stopSshEnvLabFixture does, before the root directory goes
    // away — otherwise a slow-to-exit sshd survives as an orphan with its
    // root directory already gone.
    const stopped = await escalateSshEnvLabFixtureShutdown(state);
    if (stopped) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const survivalNote =
        `SSH env-lab fixture pid ${state.pid} on port ${state.port} is still running after SIGKILL. ` +
        `Kept ${rootDir} for inspection; no state file exists to target it with a later stop call.`;
      if (error instanceof Error) {
        error.message = `${error.message}\n${survivalNote}`;
      } else {
        console.error(survivalNote);
      }
    }
    throw error;
  }
}

export async function buildSshEnvLabFixtureConfig(
  state: SshEnvLabFixtureState,
): Promise<SshConnectionConfig> {
  const [privateKey, knownHosts] = await Promise.all([
    fs.readFile(state.clientPrivateKeyPath, "utf8"),
    fs.readFile(state.knownHostsPath, "utf8"),
  ]);
  return {
    host: state.host,
    port: state.port,
    username: state.username,
    remoteWorkspacePath: state.workspaceDir,
    privateKey,
    knownHosts,
    strictHostKeyChecking: true,
  };
}

export async function readSshEnvLabFixtureStatus(statePath: string): Promise<{
  running: boolean;
  state: SshEnvLabFixtureState | null;
}> {
  const state = await readSshEnvLabFixtureState(statePath);
  if (!state) {
    return { running: false, state: null };
  }
  return {
    running: await isSshEnvLabFixtureProcess(state),
    state,
  };
}
