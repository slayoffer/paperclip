import { promises as fs } from "node:fs";
import path from "node:path";
import { shouldExcludePath } from "./exclude-patterns.js";
import { workspacePathMatcher } from "./workspace-manifest.js";
import type { DirectorySnapshot, SnapshotEntry } from "./workspace-restore-merge.js";

export function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

export class DirectoryMergeConflict extends Error {
  readonly code = "DIRECTORY_MERGE_CONFLICT";
  constructor(readonly paths: string[]) {
    super("Directory contents changed concurrently");
  }
}

/** Preflight the entire delta before writing. Identical replays are safe after
 * an interrupted apply; unrelated edits are left alone. No history is retained. */
export function directoryMergeConflicts(baseline: DirectorySnapshot, source: DirectorySnapshot, current: DirectorySnapshot): string[] {
  const same = (a: SnapshotEntry | undefined, b: SnapshotEntry | undefined) =>
    (!a && !b) || entriesMatch(a, b);
  const conflicts = new Set<string>();
  function* changedPaths() {
    for (const [name] of baseline.entries) yield name;
    for (const [name] of source.entries) if (!baseline.entries.has(name)) yield name;
  }
  for (const relative of changedPaths()) {
    const before = baseline.entries.get(relative);
    const incoming = source.entries.get(relative);
    const present = current.entries.get(relative);
    if (same(before, incoming) || same(incoming, present)) continue;
    if (!same(before, present)) conflicts.add(relative);
    // A parent removed/replaced by another writer must never be traversed.
    for (let parent = path.posix.dirname(relative); parent !== "."; parent = path.posix.dirname(parent)) {
      if (current.entries.get(parent)?.kind !== "dir" &&
          !same(current.entries.get(parent), baseline.entries.get(parent))) conflicts.add(parent);
    }
  }
  // Stream each current entry once. A replacement must not remove children
  // omitted from the baseline, including excluded or newly created files.
  for (const [child, entry] of current.entries) {
    if (same(entry, baseline.entries.get(child)) || same(entry, source.entries.get(child))) continue;
    for (let parent = path.posix.dirname(child); parent !== "."; parent = path.posix.dirname(parent)) {
      if (baseline.entries.get(parent)?.kind === "dir" && source.entries.get(parent)?.kind !== "dir") {
        conflicts.add(child);
        break;
      }
    }
  }
  return [...conflicts].sort();
}


/** Inspect only replaced directories. Never follow links or read excluded file contents. */
export async function excludedReplacementConflicts(
  targetDir: string, source: DirectorySnapshot, baseline: DirectorySnapshot,
): Promise<string[]> {
  const ignored = workspacePathMatcher(baseline.ignoredPaths);
  const conflicts: string[] = [];
  async function inspect(relative: string): Promise<string | null> {
    for await (const entry of await fs.opendir(path.join(targetDir, relative))) {
      const child = path.posix.join(relative, entry.name);
      if (shouldExcludePath(child, baseline.exclude) || ignored.matches(child)) return child;
      if (entry.isDirectory()) {
        const excluded = await inspect(child);
        if (excluded) return excluded;
      }
    }
    return null;
  }
  try {
    for (const [relative, incoming] of source.entries) {
      if (incoming.kind === "dir" || entriesMatch(baseline.entries.get(relative), incoming)) continue;
      const present = await fs.lstat(path.join(targetDir, relative)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!present?.isDirectory()) continue;
      const excluded = await inspect(relative);
      if (excluded) conflicts.push(excluded);
    }
    return conflicts.sort();
  } finally { ignored.close(); }
}
