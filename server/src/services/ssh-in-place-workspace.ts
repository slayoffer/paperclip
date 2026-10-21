import { sshWriterDirectory } from "@paperclipai/adapter-utils/ssh-writer-termination";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sshRuntimeIsolationScript } from "@paperclipai/adapter-utils/ssh-runtime-isolation";
import {
  acquireSshInPlaceWorktreeLock,
  releaseSshInPlaceWorktreeLocksForLease,
  type SshInPlaceLockHolder,
} from "./ssh-in-place-lock.js";
export type { SshInPlaceLockHolder } from "./ssh-in-place-lock.js";
import {
  runSshCommand,
  shellQuote,
  type SshCommandResult,
  type SshConnectionConfig,
} from "@paperclipai/adapter-utils/ssh";

/**
 * Same-host `in_place` execution for SSH environments (SYNA-2273).
 *
 * When the Paperclip server and the SSH host share one disk at the same
 * absolute path, a run can work directly in the server's execution workspace.
 * This removes the per-run git bundle + tar copy and the restore merge.
 * The feature is off by default. An operator turns it on per environment with
 * the server env allowlist below. See `doc/ssh-same-host-in-place.md`.
 */
export const SSH_IN_PLACE_ENVIRONMENTS_ENV = "PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS";
export const SSH_IN_PLACE_LOCK_WAIT_MS_ENV = "PAPERCLIP_SSH_IN_PLACE_LOCK_WAIT_MS";
export const DEFAULT_SSH_IN_PLACE_LOCK_WAIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Adapter types that honor an `in_place` realization: they skip the workspace
 * copy and put their runtime assets in the per-run runtime root. Other adapter
 * types always get the copy realization.
 */
export const SSH_IN_PLACE_ADAPTER_TYPES: ReadonlySet<string> = new Set(["codex_local", "claude_local"]);

export function readSshInPlaceEnvironmentAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env[SSH_IN_PLACE_ENVIRONMENTS_ENV] ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function sshInPlaceEnabledForEnvironment(
  environmentId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readSshInPlaceEnvironmentAllowlist(env).has(environmentId);
}

export function readSshInPlaceLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SSH_IN_PLACE_LOCK_WAIT_MS_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SSH_IN_PLACE_LOCK_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : DEFAULT_SSH_IN_PLACE_LOCK_WAIT_MS;
}

/**
 * The host folder for the per-run adapter runtime assets. It sits under the
 * environment's remote workspace path, outside the tracked worktree.
 */
export function buildSshInPlaceRuntimeRoot(remoteCwd: string, runId: string): string {
  return path.posix.join(remoteCwd, ".paperclip-runtime", "runs", runId);
}

export {
  acquireSshInPlaceWorktreeLock,
  readSshInPlaceWorktreeLockHolder,
  releaseSshInPlaceWorktreeLocksForLease,
} from "./ssh-in-place-lock.js";

export async function canonicalSshInPlaceLockKey(worktreePath: string): Promise<string> {
  return await fs.realpath(worktreePath);
}

/**
 * The host-side check.
 *
 * The server writes a probe file with a random token into the worktree, then
 * reads it back over SSH at the same absolute path. A match proves that the
 * host sees the same folder (not only a folder with the same name). The check
 * also requires that the host user can write the folder, and, for a git
 * worktree, that git works there on the host. The server removes the probe file
 * before it returns.
 */
export type SshInPlaceProbeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_absolute"
        | "local_missing"
        | "host_missing"
        | "host_not_writable"
        | "host_path_mismatch"
        | "host_git_unusable"
        | "probe_failed";
      detail?: string;
    };

type SshCommandRunner = (
  config: SshConnectionConfig,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<SshCommandResult>;

export async function probeSshInPlaceWorkspace(input: {
  config: SshConnectionConfig;
  localPath: string;
  runSsh?: SshCommandRunner;
}): Promise<SshInPlaceProbeResult> {
  const localPath = input.localPath;
  if (!path.posix.isAbsolute(localPath)) {
    return { ok: false, reason: "not_absolute", detail: localPath };
  }
  try {
    const stat = await fs.stat(localPath);
    if (!stat.isDirectory()) return { ok: false, reason: "local_missing", detail: localPath };
  } catch {
    return { ok: false, reason: "local_missing", detail: localPath };
  }
  const token = randomUUID();
  const probeName = `.paperclip-in-place-probe-${token}`;
  const probePath = path.join(localPath, probeName);
  const runSsh: SshCommandRunner = input.runSsh ?? runSshCommand;
  try {
    await fs.writeFile(probePath, token, { flag: "wx" });
    const p = shellQuote(localPath);
    const f = shellQuote(path.posix.join(localPath, probeName));
    const script = [
      `if [ ! -d ${p} ]; then echo host_missing; exit 0; fi`,
      `if [ ! -w ${p} ]; then echo host_not_writable; exit 0; fi`,
      `if [ ! -f ${f} ] || [ "$(cat ${f})" != ${shellQuote(token)} ]; then echo host_path_mismatch; exit 0; fi`,
      `if [ -e ${shellQuote(path.posix.join(localPath, ".git"))} ] && ! git -C ${p} rev-parse --git-dir >/dev/null 2>&1; then echo host_git_unusable; exit 0; fi`,
      `echo ok`,
    ].join("\n");
    const result = await runSsh(input.config, script, { timeoutMs: PROBE_TIMEOUT_MS });
    const verdict = result.stdout.trim().split(/\s+/).pop() ?? "";
    if (verdict === "ok") return { ok: true };
    if (
      verdict === "host_missing" ||
      verdict === "host_not_writable" ||
      verdict === "host_path_mismatch" ||
      verdict === "host_git_unusable"
    ) {
      return { ok: false, reason: verdict, detail: localPath };
    }
    return { ok: false, reason: "probe_failed", detail: `unexpected probe output: ${result.stdout.trim().slice(0, 200)}` };
  } catch (error) {
    return { ok: false, reason: "probe_failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

export type SshInPlaceDecision =
  | { mode: "in_place"; authoritativeRoot: string; runtimeRoot: string }
  | { mode: "copy"; reason: string; warn: boolean };

/**
 * Decide the realization mode for one SSH run. The function never throws: any
 * failure gives the copy mode, which is the behavior without the flag.
 * `warn` is true when the operator turned the flag on but the run still copies.
 */
export async function decideSshInPlaceRealization(input: {
  environmentId: string;
  adapterType: string | null;
  localPath: string | null | undefined;
  remoteCwd: string | null | undefined;
  leaseId: string;
  runId: string | null;
  resolveConfig: () => Promise<SshConnectionConfig>;
  isHolderActive: (holder: SshInPlaceLockHolder) => Promise<boolean>;
  isHolderStopped?: (holder: SshInPlaceLockHolder) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  runSsh?: SshCommandRunner;
  lockPollMs?: number;
}): Promise<SshInPlaceDecision> {
  const env = input.env ?? process.env;
  if (!sshInPlaceEnabledForEnvironment(input.environmentId, env)) {
    return { mode: "copy", reason: "flag_off", warn: false };
  }
  if (!input.adapterType || !SSH_IN_PLACE_ADAPTER_TYPES.has(input.adapterType)) {
    return { mode: "copy", reason: `adapter_unsupported:${input.adapterType ?? "unknown"}`, warn: false };
  }
  const localPath = input.localPath?.trim() ?? "";
  const remoteCwd = input.remoteCwd?.trim() ?? "";
  if (!localPath || !remoteCwd || !input.runId) {
    return { mode: "copy", reason: "missing_paths", warn: true };
  }
  let runtimeRoot: string;
  let key: string;
  let config: SshConnectionConfig;
  try {
    key = await canonicalSshInPlaceLockKey(localPath);
  } catch {
    return { mode: "copy", reason: "local_missing", warn: true };
  }
  try {
    config = await input.resolveConfig();
    const result = await (input.runSsh ?? runSshCommand)(config,
      `(${sshRuntimeIsolationScript(localPath, [sshWriterDirectory(remoteCwd, input.runId)])}) >/dev/null &&\n` +
        sshRuntimeIsolationScript(localPath, [buildSshInPlaceRuntimeRoot(remoteCwd, input.runId)]),
      { timeoutMs: PROBE_TIMEOUT_MS });
    runtimeRoot = result.stdout.trim();
    if (!path.posix.isAbsolute(runtimeRoot) || runtimeRoot.includes("\n")) {
      return { mode: "copy", reason: "runtime_path_unresolved", warn: true };
    }
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout ?? "").trim();
    return { mode: "copy", reason: output.startsWith("runtime_root_inside_")
      ? output : "runtime_path_unresolved", warn: true };
  }
  let lock: Awaited<ReturnType<typeof acquireSshInPlaceWorktreeLock>>;
  try {
    lock = await acquireSshInPlaceWorktreeLock({
      key,
      leaseId: input.leaseId,
      runId: input.runId,
      waitMs: readSshInPlaceLockWaitMs(env),
      pollMs: input.lockPollMs,
      isHolderActive: input.isHolderActive,
      isHolderStopped: input.isHolderStopped,
    });
  } catch {
    return { mode: "copy", reason: "worktree_lock_unavailable", warn: true };
  }
  if (!lock.acquired) {
    return { mode: "copy", reason: `worktree_busy:${lock.holder.runId ?? lock.holder.leaseId}`, warn: true };
  }

  let probe: SshInPlaceProbeResult;
  try {
    probe = await probeSshInPlaceWorkspace({
      config,
      localPath,
      runSsh: input.runSsh,
    });
  } catch (error) {
    probe = { ok: false, reason: "probe_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!probe.ok) {
    releaseSshInPlaceWorktreeLocksForLease(input.leaseId);
    return { mode: "copy", reason: `${probe.reason}${probe.detail ? `: ${probe.detail}` : ""}`, warn: true };
  }
  return { mode: "in_place", authoritativeRoot: localPath, runtimeRoot };
}
