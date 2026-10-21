import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { WorkspaceManifestMap } from "./workspace-manifest.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot, entriesMatch, type DirectorySnapshot, type SnapshotEntry } from "./workspace-directory-snapshot.js";
import { withDirectoryMergeLock } from "./workspace-directory-lock.js";
import { sshWorkspaceOperations } from "./workspace-operation-schedule.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

export * from "./workspace-directory-snapshot.js";
export * from "./workspace-directory-lock.js";
import { directoryMergeConflicts, DirectoryMergeConflict, excludedReplacementConflicts } from "./workspace-restore-safety.js";
export { directoryMergeConflicts, DirectoryMergeConflict } from "./workspace-restore-safety.js";

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const targetPath = path.join(targetDir, relative);

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  if (entry.kind === "symlink") {
    await fs.rm(targetPath, { recursive: true, force: true });
    await fs.symlink(entry.target, targetPath);
    return;
  }
  // An interrupted restore must not leave a truncated current file. Keep the
  // incoming tree until its owner records success; exact retries deduplicate.
  const temporary = path.join(path.dirname(targetPath), `.paperclip-merge-${randomUUID()}`);
  try {
    await fs.copyFile(sourcePath, temporary, fsConstants.COPYFILE_FICLONE).catch(async () => {
      await fs.copyFile(sourcePath, temporary);
    });
    await fs.chmod(temporary, entry.mode);
    const file = await fs.open(temporary, "r");
    try { await file.sync(); } finally { await file.close(); }
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) await fs.rm(targetPath, { recursive: true, force: true });
    await fs.rename(temporary, targetPath);
  } finally { await fs.rm(temporary, { force: true }); }

}

function orderedEntries(snapshot: DirectorySnapshot, reverse = false): Iterable<[string, SnapshotEntry]> {
  if (snapshot.entries instanceof WorkspaceManifestMap) return snapshot.entries.entries(reverse);
  return [...snapshot.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0) * (reverse ? -1 : 1));
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  conflictPolicy?: "reject";
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
  onProgress?: RuntimeProgressSink;
  /** Caller holds the target's writer lock and validated an immutable sparse
   * source. Unchanged entries need no payload and are never copied. */
  snapshots?: { source: DirectorySnapshot; current: DirectorySnapshot };
}): Promise<void> {
  // Direct merges obey the same ordering as SSH restores. Nested restores
  // retain their existing slot through AsyncLocalStorage.
  return sshWorkspaceOperations.run(() => mergeDirectoryWithBaselineInner(input));
}

async function mergeDirectoryWithBaselineInner(input: Parameters<typeof mergeDirectoryWithBaseline>[0]): Promise<void> {
  const options = { exclude: input.baseline.exclude, ignoredPaths: input.baseline.ignoredPaths, diskBacked: true };
  const currentOptions = input.conflictPolicy === "reject" ? { exclude: [], diskBacked: true } : options;
  const source = input.snapshots?.source ?? await captureDirectorySnapshot(input.sourceDir, options);
  let warm: DirectorySnapshot | undefined;
  try {
    // Hash target contents before acquiring the writer lock. The locked scan
    // checks nanosecond metadata and hashes only files that changed meanwhile.
    if (!input.snapshots) warm = await captureDirectorySnapshot(input.targetDir,
      { ...currentOptions, cacheMetadata: true }).catch((error: NodeJS.ErrnoException) => {
        // Another writer can remove a path or change its type after lstat.
        // Discard this optional cache and repeat the scan under the lock.
        if (["ENOENT", "ENOTDIR", "EISDIR", "EINVAL", "ELOOP", "WORKSPACE_SNAPSHOT_CHANGED"].includes(error.code ?? "")) return undefined;
        throw error;
      });
    await withDirectoryMergeLock(input.targetDir, async (canonicalTargetDir) => {
      // Strict preflight must see excluded children before a directory is
      // replaced. The merge still applies only the filtered source/baseline.
      const current = input.snapshots?.current ?? await captureDirectorySnapshot(canonicalTargetDir,
        { ...currentOptions, reuseSnapshot: warm });
      try {
        if (input.conflictPolicy === "reject") {
          const conflicts = directoryMergeConflicts(input.baseline, source, current);
          if (conflicts.length) throw new DirectoryMergeConflict(conflicts);
        } else {
          const conflicts = await excludedReplacementConflicts(canonicalTargetDir, source, input.baseline);
          if (conflicts.length) throw new DirectoryMergeConflict(conflicts);
        }
        await input.beforeApply?.();
        for (const [relative, baselineEntry] of orderedEntries(input.baseline)) {
          if (baselineEntry.kind === "dir" || source.entries.has(relative)) continue;
          if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
          await fs.rm(path.join(canonicalTargetDir, relative), { recursive: true, force: true });
        }
        // Reverse path order visits descendants before their parent directory.
        for (const [relative, entry] of orderedEntries(input.baseline, true)) {
          if (entry.kind === "dir" && !source.entries.has(relative)) await fs.rmdir(path.join(canonicalTargetDir, relative)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "ENOTDIR") throw error;
          });
        }
        for (const [relative, entry] of orderedEntries(source)) {
          if (!entriesMatch(input.baseline.entries.get(relative), entry) &&
              !(input.conflictPolicy === "reject" && entriesMatch(current.entries.get(relative), entry))) await copySnapshotEntry(input.sourceDir, canonicalTargetDir, relative, entry);
        }
        await input.afterApply?.();
      } finally { await disposeDirectorySnapshot(current); }
    }, process.env, undefined, undefined, input.onProgress);
  } finally {
    await disposeDirectorySnapshot(warm ?? null);
    await disposeDirectorySnapshot(source);
  }
}
