import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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
const LOCK_POLL_MS = 250;
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

function isPathInside(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

/**
 * The worktree lock.
 *
 * Two runs must not work in one worktree at the same time (a child issue can
 * reuse its parent's execution workspace). Every SSH run starts from this one
 * server process, so an in-process lock is sufficient: a server restart ends
 * every run and also clears the lock. The lock is keyed by the real path of the
 * worktree and is owned by the environment lease of the run. The SSH driver
 * releases it when it releases that lease. A holder whose lease is no longer
 * active is stale, and the next run takes the lock from it.
 */
export interface SshInPlaceLockHolder {
  leaseId: string;
  runId: string | null;
  acquiredAt: number;
}

const worktreeLockHolders = new Map<string, SshInPlaceLockHolder>();

export async function canonicalSshInPlaceLockKey(worktreePath: string): Promise<string> {
  try {
    return await fs.realpath(worktreePath);
  } catch {
    return path.resolve(worktreePath);
  }
}

export async function acquireSshInPlaceWorktreeLock(input: {
  key: string;
  leaseId: string;
  runId: string | null;
  waitMs: number;
  pollMs?: number;
  isHolderActive: (holder: SshInPlaceLockHolder) => Promise<boolean>;
}): Promise<{ acquired: true } | { acquired: false; holder: SshInPlaceLockHolder }> {
  const deadline = Date.now() + Math.max(0, input.waitMs);
  const pollMs = Math.max(1, input.pollMs ?? LOCK_POLL_MS);
  for (;;) {
    const current = worktreeLockHolders.get(input.key);
    if (!current || current.leaseId === input.leaseId) {
      worktreeLockHolders.set(input.key, { leaseId: input.leaseId, runId: input.runId, acquiredAt: Date.now() });
      return { acquired: true };
    }
    let active = true;
    try {
      active = await input.isHolderActive(current);
    } catch {
      // A failed check keeps the holder: a wrong steal is worse than a copy run.
      active = true;
    }
    if (!active && worktreeLockHolders.get(input.key) === current) {
      worktreeLockHolders.delete(input.key);
      continue;
    }
    if (Date.now() >= deadline) {
      return { acquired: false, holder: worktreeLockHolders.get(input.key) ?? current };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

export function releaseSshInPlaceWorktreeLocksForLease(leaseId: string): number {
  let released = 0;
  for (const [key, holder] of worktreeLockHolders) {
    if (holder.leaseId === leaseId) {
      worktreeLockHolders.delete(key);
      released += 1;
    }
  }
  return released;
}

/** Test helper: the current holder of a worktree lock. */
export function readSshInPlaceWorktreeLockHolder(key: string): SshInPlaceLockHolder | null {
  return worktreeLockHolders.get(key) ?? null;
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
  const runtimeRoot = buildSshInPlaceRuntimeRoot(remoteCwd, input.runId);
  if (isPathInside(localPath, runtimeRoot)) {
    // The runtime root must stay outside the tracked worktree.
    return { mode: "copy", reason: "runtime_root_inside_worktree", warn: true };
  }

  const key = await canonicalSshInPlaceLockKey(localPath);
  const lock = await acquireSshInPlaceWorktreeLock({
    key,
    leaseId: input.leaseId,
    runId: input.runId,
    waitMs: readSshInPlaceLockWaitMs(env),
    pollMs: input.lockPollMs,
    isHolderActive: input.isHolderActive,
  });
  if (!lock.acquired) {
    return { mode: "copy", reason: `worktree_busy:${lock.holder.runId ?? lock.holder.leaseId}`, warn: true };
  }

  let probe: SshInPlaceProbeResult;
  try {
    probe = await probeSshInPlaceWorkspace({
      config: await input.resolveConfig(),
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
