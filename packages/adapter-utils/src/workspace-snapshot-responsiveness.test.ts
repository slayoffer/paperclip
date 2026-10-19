import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, writeFile, rm, mkdir, symlink, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceFileHasher } from "./workspace-file-hasher.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-snapshot-worker-"));
  directories.push(root);
  return root;
}

it("reads and hashes file contents outside the main thread", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "file"), "snapshot data");
  const expected = crypto.createHash("sha256").update("snapshot data").digest("hex");
  const update = vi.spyOn(crypto.Hash.prototype, "update").mockImplementation(() => {
    throw new Error("File contents reached the main thread hash");
  });
  const snapshot = await captureDirectorySnapshot(root);
  expect(snapshot.entries.get("file")).toMatchObject({ kind: "file", hash: expected });
  expect(update).not.toHaveBeenCalled();
});

it("keeps timer gaps below 100 ms while capturing a large tree", async () => {
  const root = await fixture();
  const large = Buffer.alloc(1024 * 1024, 42);
  for (let i = 0; i < 1024; i++) {
    await writeFile(path.join(root, String(i)), i < 128 ? large : "small file");
  }
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  const sample = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  };
  const timer = setInterval(sample, 5);
  try {
    for (const diskBacked of [false, true]) {
      const snapshot = await captureDirectorySnapshot(root, { diskBacked });
      sample();
      try { expect(snapshot.entries.size).toBe(1024); }
      finally { await disposeDirectorySnapshot(snapshot); }
    }
  } finally { clearInterval(timer); }
  console.info(`Both snapshot formats: 1024 files, 128 MiB, ${ticks} timer samples, maximum gap ${maxGap.toFixed(1)} ms`);
  expect(ticks).toBeGreaterThan(5);
  expect(maxGap).toBeLessThan(100);
}, 60_000);

it("preserves hashes, file modes, links, and excluded paths in both snapshot formats", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "run"), Buffer.from([0, 255, 10]));
  await chmod(path.join(root, "nested", "run"), 0o755);
  await symlink("nested/run", path.join(root, "link"));
  await writeFile(path.join(root, "ignored"), "private");
  const options = { exclude: ["ignored"] };
  const memory = await captureDirectorySnapshot(root, options);
  const disk = await captureDirectorySnapshot(root, { ...options, diskBacked: true });
  try {
    expect(new Map(disk.entries)).toEqual(memory.entries);
    expect(memory.entries.get("link")).toEqual({ kind: "symlink", target: "nested/run" });
    expect(memory.entries.get("nested/run")).toEqual({ kind: "file",
      mode: (await stat(path.join(root, "nested/run"))).mode,
      hash: crypto.createHash("sha256").update(Buffer.from([0, 255, 10])).digest("hex") });
    expect(memory.entries.has("ignored")).toBe(false);
  } finally { await disposeDirectorySnapshot(disk); }
});

it("removes a private manifest after a worker scan fails", async () => {
  const root = await fixture();
  const manifest = path.join(root, "manifest");
  await mkdir(manifest);
  vi.spyOn(fs, "mkdtemp").mockResolvedValueOnce(manifest);
  await expect(captureDirectorySnapshot(path.join(root, "missing"), { diskBacked: true }))
    .rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(manifest)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves file error codes and closes the worker after a failed scan", async () => {
  const root = await fixture();
  const hasher = new WorkspaceFileHasher();
  try {
    await expect(hasher.hash(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(root, "valid"), "valid");
    await expect(hasher.hash(path.join(root, "valid"))).resolves.toMatch(/^[a-f0-9]{64}$/);
  } finally { await hasher.close(); }
  await expect(hasher.hash(path.join(root, "valid"))).rejects.toThrow("Workspace hash worker exited");
});
