import { stageSshEnvironment } from "./ssh-environment.js";
import { randomUUID } from "node:crypto";
import { SshTransportError, sshConnectTimeoutSec, withSshTransportRetry } from "./ssh-transport.js";
import { trackSshWriterCommand } from "./ssh-writer-termination.js";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import type { RunProcessResult } from "./server-utils.js";
import {
  type SshConnectionConfig,
  type SshCommandResult,
  type SshRemoteExecutionSpec,
  shellQuote,
  isValidShellEnvKey,
} from "./ssh-config.js";

export function createSshCommandManagedRuntimeRunner(input: {
  spec: SshRemoteExecutionSpec;
  defaultCwd?: string | null;
  maxBufferBytes?: number | null;
}): CommandManagedRuntimeRunner {
  const defaultCwd = input.defaultCwd?.trim() || input.spec.remoteCwd;
  const maxBufferBytes =
    typeof input.maxBufferBytes === "number" && Number.isFinite(input.maxBufferBytes) && input.maxBufferBytes > 0
      ? Math.trunc(input.maxBufferBytes)
      : 1024 * 1024;

  return {
    execute: async (commandInput): Promise<RunProcessResult> => {
      const startedAt = new Date().toISOString();
      const command = commandInput.command.trim();
      const args = commandInput.args ?? [];
      const cwd = commandInput.cwd?.trim() || defaultCwd;
      const commandScript = command === "sh" || command === "bash"
        ? (args[0] === "-c" || args[0] === "-lc") && typeof args[1] === "string"
          ? args[1]
          : `exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`
        : `exec ${[shellQuote(command), ...args.map((arg) => shellQuote(arg))].join(" ")}`;
      const remoteCommand = `cd ${shellQuote(cwd)} && ${commandScript}`;

      try {
        const result = await runSshCommand(input.spec, remoteCommand, {
          env: commandInput.env,
          stdin: commandInput.stdin,
          timeoutMs: commandInput.timeoutMs,
          maxBuffer: maxBufferBytes,
        });
        if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
        if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: result.stdout,
          stderr: result.stderr,
          pid: null,
          startedAt,
        };
      } catch (error) {
        if (error instanceof SshTransportError) throw error;
        const failure = error as {
          stdout?: unknown;
          stderr?: unknown;
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
        };
        const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
        const stderr = typeof failure.stderr === "string"
          ? failure.stderr
          : error instanceof Error
            ? error.message
            : String(error);
        if (stdout) await commandInput.onLog?.("stdout", stdout);
        if (stderr) await commandInput.onLog?.("stderr", stderr);
        return {
          exitCode: typeof failure.code === "number" ? failure.code : null,
          signal: typeof failure.signal === "string" ? failure.signal : null,
          timedOut: failure.killed === true,
          stdout,
          stderr,
          pid: null,
          startedAt,
        };
      }
    },
  };
}

export async function execFileText(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeout ?? 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 128,
        ...(file === "ssh" ? { killSignal: "SIGKILL" as const } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: stdout ?? "", stderr: stderr ?? "" }));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function spawnText(
  file: string,
  args: string[],
  options: {
    stdin?: string;
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await new Promise<SshCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [options.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const maxBuffer = options.maxBuffer ?? 1024 * 128;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let stdinError: Error | null = null;

    const finishReject = (error: Error & { stdout?: string; stderr?: string; code?: number | null; killed?: boolean }) => {
      if (settled) return;
      settled = true;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = timedOut;
      reject(error);
    };

    const append = (
      streamName: "stdout" | "stderr",
      chunk: unknown,
    ) => {
      const text = String(chunk);
      if (streamName === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (Buffer.byteLength(stdout, "utf8") > maxBuffer || Buffer.byteLength(stderr, "utf8") > maxBuffer) {
        child.kill("SIGTERM");
        finishReject(Object.assign(new Error(`Process output exceeded maxBuffer of ${maxBuffer} bytes.`), {
          code: null,
        }));
      }
    };

    let killEscalation: NodeJS.Timeout | null = null;
    const timeout = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after a 5s grace window so a hung remote
          // command that ignores SIGTERM cannot keep the child alive
          // indefinitely.
          killEscalation = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // child may have already exited between the SIGTERM and the
              // escalation — that's fine.
            }
          }, 5_000);
          killEscalation.unref?.();
        }, options.timeout)
      : null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
    };

    child.stdout?.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr?.on("data", (chunk) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      clearTimers();
      finishReject(Object.assign(error, { code: null }));
    });

    child.on("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      if (code === 0) {
        if (stdinError) {
          reject(Object.assign(stdinError, { stdout, stderr, signal, killed: timedOut }));
          return;
        }
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Process exited with code ${code ?? -1}`), {
        stdout,
        stderr,
        code,
        signal,
        killed: timedOut,
      }));
    });

    if (options.stdin != null && child.stdin) {
      // Wait for close before rejecting so remote cleanup cannot race the upload.
      child.stdin.on("error", (error) => { stdinError = error; });
      child.stdin.end(options.stdin);
    }
  });
}

export async function runLocalGit(
  localDir: string,
  args: string[],
  options: {
    timeout?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await execFileText("git", ["-C", localDir, ...args], options);
}

export async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommandPath(command)) !== null;
}

export async function resolveCommandPath(command: string): Promise<string | null> {
  try {
    const result = await execFileText("sh", ["-c", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
      maxBuffer: 8 * 1024,
    });
    const resolved = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${sshConnectTimeoutSec()}`,
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}

export async function runSshScript(
  config: SshConnectionConfig,
  script: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return await runSshCommand(
    config,
    script,
    options,
  );
}

export async function runSshCommand(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: {
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<SshCommandResult> {
  return withSshTransportRetry(
    timeoutMs => runSshCommandOnce(config, remoteCommand, { ...options, timeoutMs }),
    options.timeoutMs,
  );
}

async function runSshCommandOnce(
  config: SshConnectionConfig,
  remoteCommand: string,
  options: { env?: Record<string, string>; stdin?: string; timeoutMs: number; maxBuffer?: number },
): Promise<SshCommandResult> {
  const deadline = Date.now() + options.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let cleanup: () => Promise<void> = () => Promise.resolve();
  try {
    const auth = await createSshAuthArgs(config);
    cleanup = auth.cleanup;
    const sshArgs = [...auth.args];
    const environment = await stageSshEnvironment(options.env ?? {}, (command, stdin) =>
      runSshCommandOnce(config, command, { stdin, timeoutMs: remaining() }));
    cleanup = async () => { try { await environment.cleanup(); } finally { await auth.cleanup(); } };
    // Read login profiles before applying explicit environment overrides.
    const remoteScript = [
      'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      environment.wrap(`exec sh -c ${shellQuote(remoteCommand)}`),
    ].join(" && ");

    const marker = `paperclip-ssh-exit-${randomUUID()}:`;
    const startMarker = `\x1e${marker}started\x1f`;
    const framedScript = `printf '%s' ${shellQuote(startMarker)} >&2; ( ${remoteScript} ); paperclip_status=$?; printf '\\036${marker}%s\\037' "$paperclip_status" >&2; exit "$paperclip_status"`;
    sshArgs.push(
      "-p",
      String(config.port),
      `${config.username}@${config.host}`,
      `sh -c ${shellQuote(framedScript)}`,
    );

    try {
      const result = options.stdin != null
      ? await spawnText("ssh", sshArgs, {
          stdin: options.stdin,
          timeout: remaining(),
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        })
      : await execFileText("ssh", sshArgs, {
          timeout: remaining(),
          maxBuffer: options.maxBuffer ?? 1024 * 128,
        });
      result.stderr = result.stderr.replace(startMarker, "").replace(new RegExp(`\\x1e${marker}\\d+\\x1f`), "");
      return result;
    } catch (error) {
      const failure = error as Error & {
        stderr?: string; code?: string | number; killed?: boolean;
        remoteCommandExited?: boolean; remoteCommandStarted?: boolean;
      };
      const frame = new RegExp(`\\x1e${marker}\\d+\\x1f`);
      const started = failure.stderr?.includes(startMarker) ?? false;
      failure.remoteCommandStarted = started;
      if (!started && failure.killed) failure.code = "ETIMEDOUT";
      if (typeof failure.stderr === "string" && frame.test(failure.stderr)) {
        failure.remoteCommandExited = true;
        failure.stderr = failure.stderr.replace(frame, "");
      }
      failure.stderr = failure.stderr?.replace(startMarker, "");
      throw error;
    }
  } finally {
    await cleanup();
  }
}

export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<{
  command: string;
  args: string[];
  cleanup: () => Promise<void>;
}> {
  for (const key of Object.keys(input.env)) {
    if (!isValidShellEnvKey(key)) {
      throw new Error(`Invalid SSH environment variable key: ${key}`);
    }
  }
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [...auth.args];
  let environment;
  try {
    environment = await stageSshEnvironment(input.env, (command, stdin) =>
      runSshCommand(input.spec, command, { stdin }));
  } catch (error) {
    await auth.cleanup();
    throw error;
  }
  try {
    const remoteCommandParts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
    // Read login profiles before applying explicit environment overrides.
    const remoteScript = [
      'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
      'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
      `cd ${shellQuote(input.spec.remoteCwd)}`,
      trackSshWriterCommand(
        environment.wrap(`exec ${remoteCommandParts}`),
        input.spec.remoteWorkspacePath,
        input.env.PAPERCLIP_RUN_ID,
      ),
    ].join(" && ");

    sshArgs.push(
      "-p",
      String(input.spec.port),
      `${input.spec.username}@${input.spec.host}`,
      `sh -c ${shellQuote(remoteScript)}`,
    );

    return {
      command: "ssh",
      args: sshArgs,
      cleanup: async () => { try { await environment.cleanup(); } finally { await auth.cleanup(); } },
    };
  } catch (error) {
    await environment.cleanup();
    await auth.cleanup();
    throw error;
  }
}

export async function ensureSshWorkspaceReady(
  config: SshConnectionConfig,
): Promise<{ remoteCwd: string }> {
  const result = await runSshCommand(
    config,
    `mkdir -p ${shellQuote(config.remoteWorkspacePath)} && cd ${shellQuote(config.remoteWorkspacePath)} && pwd`,
  );
  return {
    remoteCwd: result.stdout.trim(),
  };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
