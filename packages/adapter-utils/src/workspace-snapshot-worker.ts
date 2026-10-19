import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, opendirSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { WorkspaceManifestWriter, workspacePathMatcher } from "./workspace-manifest.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import type { SnapshotEntry } from "./workspace-restore-merge.js";
import type { WorkspaceSnapshotScanInput } from "./workspace-snapshot-worker-client.js";

// All content reads, hashing, directory enumeration, and SQLite writes stay here.
const input = workerData.input as WorkspaceSnapshotScanInput;
let ignored: ReturnType<typeof workspacePathMatcher> | undefined;
let writer: WorkspaceManifestWriter | null = null;
const entries: Array<[string, SnapshotEntry]> = [];
const buffer = Buffer.allocUnsafe(64 * 1024);

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
      const stats = lstatSync(fullPath);
      if (stats.isDirectory()) {
        await add(next, { kind: "dir" });
        await walk(next);
      } else if (stats.isSymbolicLink()) {
        await add(next, { kind: "symlink", target: readlinkSync(fullPath) });
      } else if (stats.isFile()) {
        await add(next, { kind: "file", mode: stats.mode, hash: hashFile(fullPath) });
      }
    }
  } finally { directory.closeSync(); }
}

try {
  ignored = workspacePathMatcher(input.ignoredPaths);
  writer = input.manifestDirectory
    ? new WorkspaceManifestWriter(path.join(input.manifestDirectory, "paths.sqlite")) : null;
  await walk();
  const manifest = writer?.paths("baseline");
  writer?.close();
  await flushEntries();
  parentPort!.postMessage({ manifest });
} catch (error) {
  writer?.close(false);
  const failure = error as NodeJS.ErrnoException;
  parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
} finally { ignored?.close(); parentPort!.close(); }
