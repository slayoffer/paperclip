import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createWorkspaceManifest, workspacePaths, WorkspaceManifestMap, type PathManifest, type WorkspacePaths } from "./workspace-manifest.js";
import { hashWorkspaceFile } from "./workspace-file-hasher.js";
import { scanWorkspaceSnapshot } from "./workspace-snapshot-worker-client.js";

export type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry> | WorkspaceManifestMap<SnapshotEntry>;
  ignoredPaths?: WorkspacePaths;
}

export interface LegacySerializedDirectorySnapshot {
  version: 1;
  exclude: string[];
  entries: Array<[string, SnapshotEntry]>;
}

export type SerializedDirectorySnapshot = LegacySerializedDirectorySnapshot | {
  version: 2;
  exclude: string[];
  entries: PathManifest;
  ignoredPaths?: WorkspacePaths;
};
const ownedDirectorySnapshots = new WeakMap<DirectorySnapshot, string>();
// Only locally captured snapshots can supply metadata. Serialized baselines
// cannot assert that a hash belongs to this target or this filesystem.
const snapshotMetadata = new WeakMap<DirectorySnapshot, { root: string; paths: PathManifest }>();
export async function disposeDirectorySnapshot(snapshot: DirectorySnapshot | null): Promise<void> {
  if (!snapshot) return;
  snapshotMetadata.delete(snapshot);
  if (snapshot.entries instanceof WorkspaceManifestMap) {
    snapshot.entries.close();
    const ownedDirectory = ownedDirectorySnapshots.get(snapshot);
    ownedDirectorySnapshots.delete(snapshot);
    if (ownedDirectory) await fs.rm(ownedDirectory, { recursive: true, force: true });
  }
}

function parseManifestEntry(value: string): SnapshotEntry {
  const result = parseSnapshotEntry(JSON.parse(value));
  if (!result) throw new Error("Invalid workspace baseline entry");
  return result;
}

/** Call only after the controller validates a persisted manifest's path and digest. */
export function openDirectorySnapshot(value: Extract<SerializedDirectorySnapshot, { version: 2 }>): DirectorySnapshot {
  return { exclude: value.exclude, entries: new WorkspaceManifestMap(value.entries, parseManifestEntry), ignoredPaths: value.ignoredPaths };
}

function isSafeSnapshotRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === "..");
}

function parseSnapshotEntry(value: unknown): SnapshotEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "dir") return { kind: "dir" };
  if (candidate.kind === "symlink" && typeof candidate.target === "string") {
    return { kind: "symlink", target: candidate.target };
  }
  if (
    candidate.kind === "file" &&
    typeof candidate.mode === "number" &&
    Number.isInteger(candidate.mode) &&
    candidate.mode >= 0 &&
    typeof candidate.hash === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.hash)
  ) {
    return { kind: "file", mode: candidate.mode, hash: candidate.hash };
  }
  return null;
}

export function serializeDirectorySnapshot(
  snapshot: DirectorySnapshot,
): SerializedDirectorySnapshot {
  if (snapshot.entries instanceof WorkspaceManifestMap) return {
    version: 2, exclude: [...snapshot.exclude], entries: snapshot.entries.manifest,
    ...(snapshot.ignoredPaths ? { ignoredPaths: snapshot.ignoredPaths } : {}),
  };
  return {
    version: 1,
    exclude: [...snapshot.exclude],
    entries: [...snapshot.entries.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  };
}

export function parseDirectorySnapshot(
  value: unknown,
): DirectorySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.exclude) ||
    !candidate.exclude.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  const entries = new Map<string, SnapshotEntry>();
  for (const rawEntry of candidate.entries) {
    if (!Array.isArray(rawEntry) || rawEntry.length !== 2) return null;
    const [relative, rawSnapshotEntry] = rawEntry;
    if (typeof relative !== "string" || !isSafeSnapshotRelativePath(relative)) {
      return null;
    }
    const entry = parseSnapshotEntry(rawSnapshotEntry);
    if (!entry || entries.has(relative)) return null;
    entries.set(relative, entry);
  }
  return {
    exclude: [...new Set(candidate.exclude as string[])],
    entries,
  };
}

export function directorySnapshotSha256(snapshot: DirectorySnapshot): string {
  if (!(snapshot.entries instanceof WorkspaceManifestMap)) return createHash("sha256")
    .update(JSON.stringify(serializeDirectorySnapshot(snapshot))).digest("hex");
  const digest = createHash("sha256").update("workspace-baseline-v2\0").update(JSON.stringify(snapshot.exclude));
  for (const entry of snapshot.entries) digest.update(JSON.stringify(entry)).update("\0");
  return digest.digest("hex");
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashWorkspaceFile(fullPath),
  };
}

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

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[]; ignoredPaths?: WorkspacePaths; diskBacked?: boolean;
    cacheMetadata?: boolean; reuseSnapshot?: DirectorySnapshot;
    onScan?: (counts: { hashedFiles: number; reusedFiles: number }) => void } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  const manifestDirectory = options.diskBacked
    ? await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-baseline-")) : undefined;
  try {
    const root = await fs.realpath(rootDir);
    const prior = options.reuseSnapshot ? snapshotMetadata.get(options.reuseSnapshot) : undefined;
    const { entries, metadata, hashedFiles, reusedFiles } = await scanWorkspaceSnapshot({ rootDir: root,
      exclude, ignoredPaths: options.ignoredPaths, manifestDirectory,
      cacheMetadata: options.cacheMetadata, reuseMetadata: prior?.root === root ? prior.paths : undefined });
    const snapshot: DirectorySnapshot = {
      exclude, ignoredPaths: options.ignoredPaths,
      entries: entries instanceof Map ? entries : new WorkspaceManifestMap(entries, parseManifestEntry),
    };
    if (manifestDirectory) ownedDirectorySnapshots.set(snapshot, manifestDirectory);
    if (metadata) snapshotMetadata.set(snapshot, { root, paths: metadata });
    options.onScan?.({ hashedFiles, reusedFiles });
    return snapshot;
  } catch (error) {
    if (manifestDirectory) await fs.rm(manifestDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** A disk-backed subset for independent nested-repository merges. */
export async function selectDirectorySnapshot(snapshot: DirectorySnapshot, options: {
  prefix?: string; omit?: string[]; exclude: string[]; ignoredPaths?: WorkspacePaths;
  additionalIgnoredPaths?: readonly string[];
}): Promise<DirectorySnapshot> {
  const writer = await createWorkspaceManifest("paperclip-workspace-baseline-");
  try {
    let ignoredPaths = options.ignoredPaths;
    if (options.additionalIgnoredPaths?.length) {
      for (const relative of workspacePaths(ignoredPaths ?? [])) writer.add("ignored", relative);
      for (const relative of options.additionalIgnoredPaths) writer.add("ignored", relative);
      ignoredPaths = writer.paths("ignored");
    }
    for (const [relative, entry] of snapshot.entries) {
      if (options.prefix && !relative.startsWith(options.prefix)) continue;
      if (options.omit?.some((omit) => relative === omit || relative.startsWith(`${omit}/`))) continue;
      writer.add("baseline", options.prefix ? relative.slice(options.prefix.length) : relative, JSON.stringify(entry));
    }
    const result: DirectorySnapshot = { exclude: options.exclude, ignoredPaths,
      entries: new WorkspaceManifestMap(writer.paths("baseline"), parseManifestEntry) };
    writer.close();
    ownedDirectorySnapshots.set(result, path.dirname(writer.filePath));
    return result;
  } catch (error) {
    writer.close(false);
    await fs.rm(path.dirname(writer.filePath), { recursive: true, force: true });
    throw error;
  }
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
