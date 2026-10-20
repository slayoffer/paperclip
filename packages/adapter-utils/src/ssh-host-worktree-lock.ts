import { runSshCommand } from "./ssh-command.js";
import type { SshConnectionConfig } from "./ssh-config.js";
import {
  HOST_WORKTREE_MARKER_ERROR,
  HOST_WORKTREE_MARKER_LOCK,
  type HostWorktreeLayout,
  assertGitSha,
  assertHostWorktreeId,
  buildHostLockAcquireScript,
  buildHostLockReleaseScript,
  buildHostStateReadScript,
  buildHostStateWriteScript,
  hostLockDir,
  hostStatePath,
} from "./ssh-host-worktree-scripts.js";

// Host lock and state file for persistent SSH host worktrees (SYNA-2273).

export type HostWorktreeErrorCode =
  | "wip_too_large"
  | "host_worktree_dirty"
  | "host_worktree_missing"
  | "host_worktree_path_conflict"
  | "host_missing_objects"
  | "host_lock_timeout"
  | "host_export_incomplete"
  | "host_protocol_error";

export class HostWorktreeError extends Error {
  readonly code: HostWorktreeErrorCode;
  readonly details: string[];

  constructor(code: HostWorktreeErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "HostWorktreeError";
    this.code = code;
    this.details = details;
  }
}

export const HOST_SCRIPT_TIMEOUT_MS = 60_000;

export async function runHostScript(spec: SshConnectionConfig, script: string, timeoutMs = HOST_SCRIPT_TIMEOUT_MS): Promise<string> {
  const result = await runSshCommand(spec, script, { timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

/** The fields of the single `<marker>\t...` line, or a HostWorktreeError for an error marker. */
export function parseHostMarker(stdout: string, marker: string): string[] {
  const lines = stdout.split("\n");
  const failure = lines.find((line) => line.startsWith(`${HOST_WORKTREE_MARKER_ERROR}\t`));
  if (failure) {
    const [, code = "host_protocol_error", ...details] = failure.split("\t");
    const known: HostWorktreeErrorCode[] = [
      "wip_too_large", "host_worktree_dirty", "host_worktree_missing", "host_worktree_path_conflict", "host_missing_objects",
    ];
    const errorCode = (known as string[]).includes(code) ? code as HostWorktreeErrorCode : "host_protocol_error";
    const message = errorCode === "wip_too_large"
      ? `Host WIP snapshot is too large (${details[0] ?? "?"} bytes). Largest paths: ${details.slice(1).join("; ")}`
      : `Host worktree operation failed: ${code}${details.filter(Boolean).length ? ` (${details.filter(Boolean).join(", ")})` : ""}`;
    throw new HostWorktreeError(errorCode, message, details);
  }
  const line = lines.find((entry) => entry.startsWith(`${marker}\t`));
  if (!line) {
    throw new HostWorktreeError("host_protocol_error", `Host script printed no ${marker} line.`, [stdout.slice(0, 500)]);
  }
  return line.split("\t").slice(1);
}

export interface HostWorktreeLockOwner {
  runId: string;
  pid: number;
  startedAt: string;
}

export interface HostWorktreeLock {
  lockDir: string;
  owner: HostWorktreeLockOwner;
  /** Owner that held the lock before and was broken as stale, if any. */
  brokenOwner: HostWorktreeLockOwner | null;
  /** True when the lock already belonged to this runId. */
  reentered: boolean;
  release(): Promise<"released" | "not_owner" | "absent">;
}

function parseLockOwner(raw: string): HostWorktreeLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HostWorktreeLockOwner>;
    if (typeof parsed.runId !== "string" || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return { runId: parsed.runId, pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

async function compareAndRemoveLock(
  spec: SshConnectionConfig,
  lockDir: string,
  expectedOwnerJson: string,
  minAgeSeconds = 0,
): Promise<"released" | "not_owner" | "absent"> {
  const stdout = await runHostScript(spec, buildHostLockReleaseScript({ lockDir, expectedOwnerJson, minAgeSeconds }));
  const [status] = parseHostMarker(stdout, HOST_WORKTREE_MARKER_LOCK);
  if (status === "released" || status === "not_owner" || status === "absent") return status;
  throw new HostWorktreeError("host_protocol_error", `Unexpected host lock release status: ${status}`);
}

/**
 * Take the per-execution-workspace host lock (`locks/<ewId>/`, mkdir-based).
 * A held lock is broken only when `isOwnerStale` says its run is terminal, or
 * when it has no owner file for `ownerlessStaleSeconds`.
 */
export async function acquireHostWorktreeLock(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  ewId: string;
  runId: string;
  pid?: number;
  waitMs?: number;
  pollMs?: number;
  ownerlessStaleSeconds?: number;
  isOwnerStale?: (owner: HostWorktreeLockOwner) => boolean | Promise<boolean>;
}): Promise<HostWorktreeLock> {
  const lockDir = hostLockDir(input.layout, input.ewId);
  const owner: HostWorktreeLockOwner = {
    runId: assertHostWorktreeId("run id", input.runId),
    pid: input.pid ?? process.pid,
    startedAt: new Date().toISOString(),
  };
  const ownerJson = JSON.stringify(owner);
  const waitMs = Math.max(0, input.waitMs ?? 10 * 60_000);
  const pollMs = Math.max(10, input.pollMs ?? 2_000);
  const ownerlessStaleSeconds = Math.max(0, input.ownerlessStaleSeconds ?? 60);
  const deadline = Date.now() + waitMs;
  let brokenOwner: HostWorktreeLockOwner | null = null;
  let lastOwner: HostWorktreeLockOwner | null = null;

  const makeLock = (heldOwner: HostWorktreeLockOwner, heldOwnerJson: string, reentered: boolean): HostWorktreeLock => ({
    lockDir,
    owner: heldOwner,
    brokenOwner,
    reentered,
    release: () => compareAndRemoveLock(input.spec, lockDir, heldOwnerJson),
  });

  for (;;) {
    const stdout = await runHostScript(input.spec, buildHostLockAcquireScript({ layout: input.layout, lockDir, ownerJson }));
    const [status, ageText = "0", ...rest] = parseHostMarker(stdout, HOST_WORKTREE_MARKER_LOCK);
    if (status === "acquired") return makeLock(owner, ownerJson, false);
    if (status !== "held") {
      throw new HostWorktreeError("host_protocol_error", `Unexpected host lock status: ${status}`);
    }
    const heldRaw = rest.join("\t");
    const held = heldRaw ? parseLockOwner(heldRaw) : null;
    lastOwner = held;
    if (held && held.runId === owner.runId) return makeLock(held, heldRaw, true);

    let broke = false;
    if (held && input.isOwnerStale && await input.isOwnerStale(held)) {
      broke = (await compareAndRemoveLock(input.spec, lockDir, heldRaw)) !== "not_owner";
      if (broke) brokenOwner = held;
    } else if (!held && Number(ageText) >= ownerlessStaleSeconds) {
      broke = (await compareAndRemoveLock(input.spec, lockDir, heldRaw, ownerlessStaleSeconds)) !== "not_owner";
    }
    if (broke) continue;

    if (Date.now() + pollMs > deadline) {
      throw new HostWorktreeError(
        "host_lock_timeout",
        `Timed out waiting for host worktree lock ${input.ewId}${lastOwner ? ` held by run ${lastOwner.runId}` : ""}.`,
        lastOwner ? [lastOwner.runId] : [],
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export type HostWorktreeStateStatus = "running" | "synced" | "failed";

export interface HostWorktreeState {
  headSha: string | null;
  wipSha: string | null;
  runId: string | null;
  status: HostWorktreeStateStatus;
  updatedAt: string;
  repoKey?: string;
  worktreeName?: string;
  branch?: string | null;
}

const STATE_STATUSES: HostWorktreeStateStatus[] = ["running", "synced", "failed"];

function nullableSha(kind: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid host worktree state ${kind}`);
  return assertGitSha(kind, value);
}

export function parseHostWorktreeState(raw: string): HostWorktreeState | null {
  const text = raw.trim();
  if (!text) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !STATE_STATUSES.includes(parsed.status as HostWorktreeStateStatus)) return null;
  try {
    return {
      headSha: nullableSha("head sha", parsed.headSha),
      wipSha: nullableSha("wip sha", parsed.wipSha),
      runId: typeof parsed.runId === "string" ? assertHostWorktreeId("run id", parsed.runId) : null,
      status: parsed.status as HostWorktreeStateStatus,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(typeof parsed.repoKey === "string" ? { repoKey: parsed.repoKey } : {}),
      ...(typeof parsed.worktreeName === "string" ? { worktreeName: parsed.worktreeName } : {}),
      ...(typeof parsed.branch === "string" || parsed.branch === null ? { branch: parsed.branch as string | null } : {}),
    };
  } catch {
    return null;
  }
}

export async function readHostWorktreeState(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  ewId: string;
}): Promise<HostWorktreeState | null> {
  const stdout = await runHostScript(input.spec, buildHostStateReadScript({ statePath: hostStatePath(input.layout, input.ewId) }));
  return parseHostWorktreeState(stdout);
}

/** Atomic write (tmp file + mv) of `state/<ewId>.json`. */
export async function writeHostWorktreeState(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  ewId: string;
  state: Omit<HostWorktreeState, "updatedAt"> & { updatedAt?: string };
}): Promise<HostWorktreeState> {
  const state: HostWorktreeState = { ...input.state, updatedAt: input.state.updatedAt ?? new Date().toISOString() };
  if (!parseHostWorktreeState(JSON.stringify(state))) {
    throw new Error("Invalid host worktree state");
  }
  await runHostScript(input.spec, buildHostStateWriteScript({
    layout: input.layout,
    statePath: hostStatePath(input.layout, input.ewId),
    stateJson: JSON.stringify(state),
  }));
  return state;
}
