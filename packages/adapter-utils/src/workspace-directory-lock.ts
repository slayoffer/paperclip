import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";
import { workspaceRestoreProgressSink, type WorkspaceRestoreDiagnostic } from "./workspace-restore-diagnostics.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import { timeWorkspaceStep } from "./workspace-operation-schedule.js";

const DEFAULT_LOCK_WAIT_MS = 15 * 60_000;

export function directoryMergeLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PAPERCLIP_RESTORE_LOCK_WAIT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LOCK_WAIT_MS;
}
const LOCK_DIAGNOSTIC_READ_TIMEOUT_MS = 100;
const activeDirectoryMergeLocks = new Set<string>();
const MAX_LOCK_DIAGNOSTIC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type DirectoryMergeLockOperation =
  | "agent_directory_prepare"
  | "agent_directory_release"
  | "agent_directory_collect"
  | "agent_directory_checkpoint"
  | "agent_directory_handoff";

/** Evidence only: neither process age nor this module's holder set can prove
 * that a lock in another process or PID namespace is safe to reclaim. */
async function directoryMergeLockDiagnostics(lockDir: string, waitMs: number, ownerPath: string): Promise<Record<string, string | number | boolean>> {
  const diagnostics: Record<string, string | number | boolean> = {
    ownerState: "unknown",
    knownLocalHolder: activeDirectoryMergeLocks.has(lockDir),
    waitMs: Math.min(MAX_LOCK_DIAGNOSTIC_AGE_MS, Math.max(0, Math.floor(waitMs))),
  };
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Abort is best effort: race the read as well so a stalled filesystem
    // cannot keep the original lock timeout from reaching its caller.
    const raw = await Promise.race([
      fs.readFile(ownerPath, { encoding: "utf8", signal: controller.signal }),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), LOCK_DIAGNOSTIC_READ_TIMEOUT_MS);
      }),
    ]);
    if (raw === undefined) return diagnostics;
    let owner: { pid?: unknown; createdAt?: unknown } | null;
    try {
      owner = JSON.parse(raw) as typeof owner;
    } catch {
      diagnostics.ownerState = "invalid";
      return diagnostics;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) {
      diagnostics.ownerState = "invalid";
      return diagnostics;
    }
    const pid = owner.pid as number;
    diagnostics.ownerSameProcess = pid === process.pid;
    try {
      process.kill(pid, 0);
      diagnostics.ownerState = "alive";
    } catch (error) {
      diagnostics.ownerState = (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : NaN;
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      diagnostics.ownerAgeMs = Math.min(MAX_LOCK_DIAGNOSTIC_AGE_MS, Math.floor(ageMs));
      if (pid === process.pid) diagnostics.ownerPredatesProcess = ageMs > process.uptime() * 1000 + 1000;
    }
  } catch (error) {
    diagnostics.ownerState = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return diagnostics;
}

/**
 * The stable `code` a lock-timeout error carries, so a caller can identify it
 * without matching on the error message text (the message embeds the lock
 * directory path).
 */
export const WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE = "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT";

/**
 * The closed set of codes a failed workspace restore can carry off the
 * sandbox. Every code is safe to store on a run record readable by any
 * same-company actor: none embeds a filesystem path, a raw error message, or
 * a process id.
 */
export type WorkspaceRestoreFailureCode =
  | "restore_permission_denied"
  | "restore_lock_timeout"
  | "restore_unsafe_archive"
  | "restore_failed";

/**
 * The outcome of one workspace restore. `ok: true` on a clean restore. `ok:
 * false` carries one allowlisted {@link WorkspaceRestoreFailureCode} — never a
 * raw error, a path, or a process id.
 */
export type WorkspaceRestoreOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WorkspaceRestoreFailureCode; readonly diagnostic?: WorkspaceRestoreDiagnostic };

/**
 * Classifies a caught workspace-restore error into one allowlisted code. Maps
 * `EACCES` and `EPERM` to a permission failure, the merge-lock timeout
 * (matched by {@link WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE}, never by the error
 * message text) to a lock-timeout failure, and every other error to a generic
 * failure. The known Daytona confinement diagnostic also identifies unsafe
 * archives across plugin transports that retain only a message. Never returns
 * raw messages, paths or process IDs.
 */
export function classifyWorkspaceRestoreFailure(error: unknown): WorkspaceRestoreFailureCode {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "EACCES" || code === "EPERM") return "restore_permission_denied";
  if (code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) return "restore_lock_timeout";
  const message = error instanceof Error ? error.message : "";
  const archiveRefused = /Daytona syncOut refusing (?:tarball (?:with an unparseable entry listing|(?:link whose target|member that) escapes the extraction dir)|unparseable or ambiguous (?:sym|hard)link entry)/.test(message);
  const outboundPathRefused = /Daytona sync source path (?:is not a confined absolute path|escapes the workspace remote dir):/.test(message);
  // These are the fail-closed guard's own exit codes. Transport/command failures
  // with other exit codes retain the existing transient failure policy.
  const outboundGuardRefused = /Daytona outbound symlink-escape guard command failed \(exit (?:40|41|42|44|45)\)/.test(message);
  if (code === "WORKSPACE_RESTORE_UNSAFE_ARCHIVE" ||
      archiveRefused || outboundPathRefused || outboundGuardRefused) {
    return "restore_unsafe_archive";
  }
  return "restore_failed";
}

/**
 * The fixed, allowlisted line an ACP adapter writes to the run log when a
 * workspace restore fails. Every call site must pass this to `onLog` instead
 * of the caught error's own message: the caught error can carry a host
 * filesystem path or the lock owner's process id, and the run log is
 * readable by any same-company actor. Never add the code's raw
 * `Error.message` to this text.
 */
export function describeWorkspaceRestoreFailure(code: WorkspaceRestoreFailureCode): string {
  switch (code) {
    case "restore_permission_denied":
      return "the restore could not write to the workspace (permission denied)";
    case "restore_lock_timeout":
      return "the restore timed out waiting for the workspace merge lock";
    case "restore_unsafe_archive":
      return "the archive contains an unsafe link or path; workspace repair is required";
    case "restore_failed":
      return "the restore failed";
  }
}

async function acquireDirectoryMergeLock(lockDir: string, operation: DirectoryMergeLockOperation | undefined, waitMs: number): Promise<() => Promise<void>> {
  const startedAt = performance.now();
  const deadline = Date.now() + waitMs;
  const databasePath = `${lockDir}.sqlite`;
  const ownerPath = `${lockDir}.owner.json`;
  async function waitForLock(diagnosticOwnerPath: string) {
    if (Date.now() >= deadline) {
      const timeoutError: NodeJS.ErrnoException & { workspaceRestoreLock?: Record<string, string | number | boolean> } = new Error(
        `Timed out waiting for workspace restore lock at ${lockDir}`,
      );
      timeoutError.code = WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE;
      // Keep the original timeout if the diagnostic read itself fails.
      timeoutError.workspaceRestoreLock = await directoryMergeLockDiagnostics(lockDir, performance.now() - startedAt, diagnosticOwnerPath).catch(() => undefined);
      if (operation && timeoutError.workspaceRestoreLock) timeoutError.workspaceRestoreLock.operation = operation;
      throw timeoutError;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // SQLite's RESERVED file lock is the authority, including across processes
  // and PID namespaces. It is released by the OS on a crash. The empty database
  // is permanent: unlinking it would let contenders lock different inodes.
  // node:sqlite is already required for workspace manifests; no native add-on
  // or external flock command is needed on macOS, Linux, or Windows.
  const databaseStat = await fs.lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (databaseStat && (!databaseStat.isFile() || databaseStat.isSymbolicLink() || databaseStat.nlink !== 1)) {
    throw new Error("Directory merge lock database is not a plain, unshared file.");
  }
  // Let SQLite create and manage every descriptor for this inode. On POSIX,
  // closing a raw fs.open descriptor could release another connection's locks.
  // The parent is private (0700), including while a new file is chmodded.
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  try {
    await fs.chmod(databasePath, 0o600);
    // Never block the event loop while another async operation holds the lock.
    database.exec("PRAGMA busy_timeout=0;");
    while (true) {
      try {
        database.exec("BEGIN IMMEDIATE;");
        break;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (typeof code !== "number" || (code & 0xff) !== 5) throw error; // SQLITE_BUSY
        await waitForLock(ownerPath);
      }
    }

    // Old processes do not participate in the SQLite protocol. Never infer
    // that a legacy owner is dead from PID existence, age, or missing metadata.
    // Drain old writers before upgrading. A leftover legacy directory requires
    // explicit offline cleanup; a live legacy holder can still release normally.
    while (await fs.lstat(lockDir).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    })) await waitForLock(path.join(lockDir, "owner.json"));

    const owner = await fs.open(ownerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await owner.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    } finally { await owner.close(); }
    activeDirectoryMergeLocks.add(lockDir);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        // This sidecar is diagnostic only. A failed removal cannot retain
        // ownership, and the next holder replaces it while holding the DB lock.
        await fs.unlink(ownerPath).catch(() => undefined);
      } finally {
        activeDirectoryMergeLocks.delete(lockDir);
        database.close();
      }
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

const DIRECTORY_MERGE_LOCK_ROOT_MODE = 0o700;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the private, instance-scoped root for every directory-merge lock:
 * `<instance root>/locks/directory-merge`. Every process that can mutate one
 * target directory must resolve to the same `PAPERCLIP_HOME` and
 * `PAPERCLIP_INSTANCE_ID`. That shared resolution is what keeps mutual
 * exclusion true for all five callers of `withDirectoryMergeLock`, including
 * the three Codex credential call sites that never touch a workspace.
 *
 * This never falls back to `os.tmpdir()` and never places the lock beside the
 * target directory: both paths funnel through this one instance-scoped root,
 * so a read-only target parent (the workspace-restore bug) cannot block a
 * lock acquisition.
 *
 * The root reads `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` from `env`, so an
 * environment-parameterized caller (a Codex credential call site that builds
 * its own `env` object instead of reading `process.env`) resolves its lock
 * root under the same instance root as the directory it protects. This never
 * reads `process.env` when the caller passes an `env`: every fallback inside
 * the resolver also reads from that same `env` object. A caller that omits
 * `env` gets `process.env`, which keeps the resolution unchanged for the
 * workspace-restore call site.
 *
 * The root is validated, not trusted: `lstat` rejects a symlink and rejects
 * any non-directory before use (fail closed). `fs.mkdir` does not change the
 * mode of a directory that already exists, so an existing valid directory
 * keeps whatever mode it already has; only a freshly created root gets mode
 * `0o700`.
 *
 * The existence check and the `mkdir` below are two separate calls, so a
 * racing writer can plant a symlink at `lockRoot` in between them. `fs.mkdir`
 * with `recursive: true` does not fail on a leaf that already exists as a
 * symlink to a real directory, so a successful `mkdir` call alone does not
 * prove the path is a plain directory. The `lstat` after `mkdir` closes that
 * window: it validates what is actually at `lockRoot` (never a `stat`, which
 * would follow the symlink) before any caller treats it as the lock root.
 */
async function resolveDirectoryMergeLockRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  const lockRoot = path.join(instanceRoot, "locks", "directory-merge");
  const existing = await fs.lstat(lockRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
    }
    return lockRoot;
  }
  await fs.mkdir(lockRoot, { recursive: true, mode: DIRECTORY_MERGE_LOCK_ROOT_MODE });
  const created = await fs.lstat(lockRoot);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Directory merge lock root at ${lockRoot} is not a plain directory.`);
  }
  return lockRoot;
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: (canonicalTargetDir: string) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
  diagnosticOperation?: DirectoryMergeLockOperation,
  // Test seam only: overrides how long acquisition waits before it reports a
  // timeout. Production callers must omit this and keep the real budget.
  waitMs: number = directoryMergeLockWaitMs(env),
  onProgress: RuntimeProgressSink | undefined = workspaceRestoreProgressSink(),
): Promise<T> {
  // Canonicalize before we hash or lock: a retargeted symlink must not let the
  // lock protect one directory while the caller mutates another.
  const canonicalTargetDir = await fs.realpath(targetDir);
  const lockRoot = await resolveDirectoryMergeLockRoot(env);
  const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
  // Progress output must never prevent lock release or mask the operation error.
  const progress: RuntimeProgressSink = async (message) => {
    try { await onProgress?.(message); } catch { /* Logging cannot retain ownership. */ }
  };
  const releaseLock = await timeWorkspaceStep(progress, "Workspace merge lock wait", () =>
    acquireDirectoryMergeLock(path.join(lockRoot, `${lockKey}.lock`), diagnosticOperation, waitMs));
  return timeWorkspaceStep(progress, "Workspace merge lock hold", async () => {
    try { return await fn(canonicalTargetDir); }
    finally { await releaseLock(); }
  });
}
