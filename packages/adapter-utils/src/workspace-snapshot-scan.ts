import { createHash } from "node:crypto";
import { createReadStream, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { WorkspaceManifestMap, WorkspaceManifestWriter, workspacePathMatcher, type PathManifest } from "./workspace-manifest.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import type { SnapshotEntry } from "./workspace-restore-merge.js";
import type { WorkspaceSnapshotScanInput } from "./workspace-snapshot-worker-client.js";

type ScannedEntry = {
  relative: string;
  entry: SnapshotEntry | null;
  metadata?: { fingerprint: string; hash: string };
};

/** Runs inside the snapshot worker. Drain each bounded batch before writing or closing its manifest. */
export async function scanWorkspaceSnapshotFiles(
  input: WorkspaceSnapshotScanInput,
  publishEntries: (entries: Array<[string, SnapshotEntry]>) => Promise<void>,
): Promise<{ manifest?: PathManifest; metadata?: PathManifest; hashedFiles: number; reusedFiles: number }> {
  const ignored = workspacePathMatcher(input.ignoredPaths);
  let writer: WorkspaceManifestWriter | null = null;
  let cached: WorkspaceManifestMap<{ fingerprint: string; hash: string }> | undefined;
  const entries: Array<[string, SnapshotEntry]> = [];
  let hashedFiles = 0;
  let reusedFiles = 0;

  function fingerprint(stats: BigIntStats): string {
    return [stats.dev, stats.ino, stats.size, stats.mode, stats.mtimeNs, stats.ctimeNs].join(":");
  }

  async function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", chunk => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async function readEntry(relative: string): Promise<ScannedEntry> {
    const fullPath = path.join(input.rootDir, relative);
    const stats = await fs.lstat(fullPath, { bigint: true });
    if (stats.isDirectory()) return { relative, entry: { kind: "dir" } };
    if (stats.isSymbolicLink()) return { relative, entry: { kind: "symlink", target: await fs.readlink(fullPath) } };
    if (!stats.isFile()) return { relative, entry: null };
    const key = fingerprint(stats);
    const prior = cached?.get(relative);
    let hash: string;
    if (prior?.fingerprint === key) {
      hash = prior.hash;
      reusedFiles++;
    } else {
      hash = await hashFile(fullPath);
      hashedFiles++;
      if (input.cacheMetadata && fingerprint(await fs.lstat(fullPath, { bigint: true })) !== key) {
        throw Object.assign(new Error("Workspace file changed during snapshot"), { code: "WORKSPACE_SNAPSHOT_CHANGED" });
      }
    }
    return { relative, entry: { kind: "file", mode: Number(stats.mode), hash },
      metadata: input.cacheMetadata ? { fingerprint: key, hash } : undefined };
  }

  async function flushEntries() {
    if (entries.length) await publishEntries(entries.splice(0));
  }

  async function visitBatch(paths: string[]) {
    const results = await Promise.allSettled(paths.map(readEntry));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { relative, entry, metadata } = result.value;
      if (!entry) continue;
      if (writer) {
        writer.add("baseline", relative, JSON.stringify(entry));
        if (metadata) writer.add("metadata", relative, JSON.stringify(metadata));
      } else {
        entries.push([relative, entry]);
        if (entries.length >= 128) await flushEntries();
      }
      if (entry.kind === "dir") await walk(relative);
    }
  }

  async function walk(relative = "") {
    let batch: string[] = [];
    for await (const entry of await fs.opendir(path.join(input.rootDir, relative))) {
      const next = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (shouldExcludePath(next, input.exclude) || ignored.matches(next)) continue;
      batch.push(next);
      if (batch.length === 16) {
        await visitBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await visitBatch(batch);
  }

  try {
    writer = input.manifestDirectory
      ? new WorkspaceManifestWriter(path.join(input.manifestDirectory, "paths.sqlite")) : null;
    if (input.cacheMetadata && !writer) throw new Error("Snapshot metadata requires a private manifest");
    cached = input.reuseMetadata ? new WorkspaceManifestMap(input.reuseMetadata, JSON.parse) : undefined;
    await walk();
    const manifest = writer?.paths("baseline");
    const metadata = input.cacheMetadata ? writer!.paths("metadata") : undefined;
    writer?.close();
    await flushEntries();
    return { manifest, metadata, hashedFiles, reusedFiles };
  } catch (error) {
    writer?.close(false);
    throw error;
  } finally { cached?.close(); ignored.close(); }
}
