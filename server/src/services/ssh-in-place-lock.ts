import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SshInPlaceLockHolder {
  leaseId: string;
  runId: string | null;
  acquiredAt: number;
  ownerId: string;
}

const ownerId = randomUUID();
// This index supports normal release. The file is the ownership authority.
const ownedKeys = new Set<string>();

function lockPaths(key: string) {
  const root = path.join(path.dirname(key), ".paperclip-in-place-locks");
  const file = path.join(root, createHash("sha256").update(key).digest("hex"));
  return { root, file, guard: `${file}.guard` };
}

export function readSshInPlaceWorktreeLockHolder(key: string): SshInPlaceLockHolder | null {
  try {
    const value = JSON.parse(readFileSync(lockPaths(key).file, "utf8"));
    if (typeof value.leaseId !== "string" || typeof value.ownerId !== "string" ||
        typeof value.acquiredAt !== "number" ||
        !(value.runId === null || typeof value.runId === "string")) {
      throw new Error("Invalid SSH worktree lock");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Serialize file creation, replacement, and release across server processes.
// An interrupted guard stays closed. No timeout proves remote writer death.
function withGuard<T>(key: string, action: () => T): T | undefined {
  const { root, guard } = lockPaths(key);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try {
    return action();
  } finally {
    rmdirSync(guard);
  }
}

export async function acquireSshInPlaceWorktreeLock(input: {
  key: string;
  leaseId: string;
  runId: string | null;
  waitMs: number;
  pollMs?: number;
  isHolderActive: (holder: SshInPlaceLockHolder) => Promise<boolean>;
  /** Positive provider evidence, never a lease timeout or controller PID. */
  isHolderStopped?: (holder: SshInPlaceLockHolder) => Promise<boolean>;
}): Promise<{ acquired: true } | { acquired: false; holder: SshInPlaceLockHolder }> {
  const deadline = Date.now() + Math.max(0, input.waitMs);
  for (;;) {
    const observed = readSshInPlaceWorktreeLockHolder(input.key);
    let stopped = false;
    if (observed && input.isHolderStopped) {
      try {
        stopped = !await input.isHolderActive(observed) && await input.isHolderStopped(observed);
      } catch {
        // Missing or failed termination evidence preserves ownership.
      }
    }
    const acquired = withGuard(input.key, () => {
      const current = readSshInPlaceWorktreeLockHolder(input.key);
      if (current?.leaseId === input.leaseId && current.ownerId === ownerId) return true;
      if (current && !(stopped && current.ownerId === observed?.ownerId &&
          current.leaseId === observed.leaseId && current.acquiredAt === observed.acquiredAt)) return false;
      const holder: SshInPlaceLockHolder = {
        leaseId: input.leaseId, runId: input.runId, acquiredAt: Date.now(), ownerId,
      };
      writeFileSync(lockPaths(input.key).file, JSON.stringify(holder), { mode: 0o600 });
      ownedKeys.add(input.key);
      return true;
    });
    if (acquired) return { acquired: true };
    if (Date.now() >= deadline) {
      return { acquired: false, holder: readSshInPlaceWorktreeLockHolder(input.key) ?? {
        leaseId: "unknown", runId: null, acquiredAt: 0, ownerId: "unknown",
      } };
    }
    await new Promise((resolve) => setTimeout(resolve,
      Math.min(Math.max(1, input.pollMs ?? 250), Math.max(1, deadline - Date.now()))));
  }
}

export function releaseSshInPlaceWorktreeLocksForLease(leaseId: string): number {
  let released = 0;
  for (const key of ownedKeys) {
    withGuard(key, () => {
      const holder = readSshInPlaceWorktreeLockHolder(key);
      if (holder?.leaseId !== leaseId || holder.ownerId !== ownerId) return;
      unlinkSync(lockPaths(key).file);
      ownedKeys.delete(key);
      released += 1;
    });
  }
  return released;
}
