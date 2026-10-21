import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, opendirSync, lstatSync, readlinkSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { WorkspaceManifestMap, WorkspaceManifestWriter, workspacePathMatcher } from "./workspace-manifest.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import type { SnapshotEntry } from "./workspace-restore-merge.js";
import type { WorkspaceSnapshotScanInput } from "./workspace-snapshot-worker-client.js";

// All content reads, hashing, directory enumeration, and SQLite writes stay here.
const input = workerData.input as WorkspaceSnapshotScanInput;
let ignored: ReturnType<typeof workspacePathMatcher> | undefined;
let writer: WorkspaceManifestWriter | null = null;
const entries: Array<[string, SnapshotEntry]> = [];
const buffer = Buffer.allocUnsafe(64 * 1024);
let cached: WorkspaceManifestMap<{ fingerprint: string; hash: string }> | undefined;
let hashedFiles = 0;
let reusedFiles = 0;

function fingerprint(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mode, stats.mtimeNs, stats.ctimeNs].join(":");
}

function fileEntry(fullPath: string, relative: string, stats: BigIntStats): SnapshotEntry {
  const key = fingerprint(stats);
  const prior = cached?.get(relative);
  let hash: string;
  if (prior?.fingerprint === key) {
    hash = prior.hash;
    reusedFiles++;
  } else {
    hash = hashFile(fullPath);
    hashedFiles++;
    // Never reuse a hash from a file that changed during the content read.
    if (input.cacheMetadata && fingerprint(lstatSync(fullPath, { bigint: true })) !== key) {
      throw Object.assign(new Error("Workspace file changed during snapshot"), { code: "WORKSPACE_SNAPSHOT_CHANGED" });
    }
  }
  if (input.cacheMetadata) writer!.add("metadata", relative, JSON.stringify({ fingerprint: key, hash }));
  return { kind: "file", mode: Number(stats.mode), hash };
}

function hashFile(filePath: string): string {
  const fd = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

async function flushEntries(): Promise<void> {
  if (!entries.length) return;
  const acknowledgement = new Promise<void>((resolve) => parentPort!.once("message", () => resolve()));
  parentPort!.postMessage({ batch: entries.splice(0) });
  await acknowledgement;
}

async function add(relative: string, entry: SnapshotEntry): Promise<void> {
  if (writer) writer.add("baseline", relative, JSON.stringify(entry));
  else {
    entries.push([relative, entry]);
    if (entries.length >= 128) await flushEntries();
  }
}

async function walk(relative = ""): Promise<void> {
  const directory = opendirSync(path.join(input.rootDir, relative));
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      const next = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (shouldExcludePath(next, input.exclude) || ignored!.matches(next)) continue;
      const fullPath = path.join(input.rootDir, next);
      const stats = lstatSync(fullPath, { bigint: true });
      if (stats.isDirectory()) {
        await add(next, { kind: "dir" });
        await walk(next);
      } else if (stats.isSymbolicLink()) {
        await add(next, { kind: "symlink", target: readlinkSync(fullPath) });
      } else if (stats.isFile()) {
        await add(next, fileEntry(fullPath, next, stats));
      }
    }
  } finally { directory.closeSync(); }
}

try {
  ignored = workspacePathMatcher(input.ignoredPaths);
  writer = input.manifestDirectory
    ? new WorkspaceManifestWriter(path.join(input.manifestDirectory, "paths.sqlite")) : null;
  if (input.cacheMetadata && !writer) throw new Error("Snapshot metadata requires a private manifest");
  cached = input.reuseMetadata ? new WorkspaceManifestMap(input.reuseMetadata, JSON.parse) : undefined;
  await walk();
  const manifest = writer?.paths("baseline");
  const metadata = input.cacheMetadata ? writer!.paths("metadata") : undefined;
  writer?.close();
  await flushEntries();
  parentPort!.postMessage({ manifest, metadata, hashedFiles, reusedFiles });
} catch (error) {
  writer?.close(false);
  const failure = error as NodeJS.ErrnoException;
  parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
} finally { cached?.close(); ignored?.close(); parentPort!.close(); }
