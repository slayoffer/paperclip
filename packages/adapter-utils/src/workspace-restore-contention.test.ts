import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureDirectorySnapshot, disposeDirectorySnapshot, mergeDirectoryWithBaseline,
  openDirectorySnapshot, serializeDirectorySnapshot, withDirectoryMergeLock,
  directoryMergeLockWaitMs, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "./workspace-restore-merge.js";
import { sshWorkspaceOperations } from "./workspace-operation-schedule.js";
import { withWorkspaceRestoreDiagnostics } from "./workspace-restore-diagnostics.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-contention-"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
  vi.stubEnv("PAPERCLIP_RESTORE_LOCK_WAIT_MS", "");
  const target = path.join(root, "target");
  await mkdir(target);
  return { root, target };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("completes two restores in order when the first holds the lock beyond 30 seconds", async () => {
  const { root, target } = await fixture();
  const baseline = await captureDirectorySnapshot(target);
  const first = path.join(root, "first"), second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, "first.txt"), "first result");
  await writeFile(path.join(second, "second.txt"), "second result");
  const acquired = deferred(), contenderWaiting = deferred();
  const events: string[] = [];
  const logs: string[] = [];
  const started = performance.now();
  const a = mergeDirectoryWithBaseline({ baseline, sourceDir: first, targetDir: target,
    onProgress: async (line) => { logs.push(line); },
    beforeApply: async () => {
      events.push("first acquired");
      acquired.resolve();
      await contenderWaiting.promise;
      await new Promise((resolve) => setTimeout(resolve, 31_000));
    }, afterApply: async () => { events.push("first applied"); } });
  await acquired.promise;
  const b = mergeDirectoryWithBaseline({ baseline, sourceDir: second, targetDir: target,
    onProgress: async (line) => {
      logs.push(line);
      if (line.includes("lock wait started")) contenderWaiting.resolve();
    },
    beforeApply: async () => { events.push("second acquired"); } });
  await Promise.all([a, b]);
  expect(performance.now() - started).toBeGreaterThan(30_000);
  expect(events).toEqual(["first acquired", "first applied", "second acquired"]);
  expect(await readFile(path.join(target, "first.txt"), "utf8")).toBe("first result");
  expect(await readFile(path.join(target, "second.txt"), "utf8")).toBe("second result");
  expect(logs.filter((line) => /lock wait completed in \d+ ms/.test(line))).toHaveLength(2);
  expect(logs.filter((line) => /lock hold completed in \d+ ms/.test(line))).toHaveLength(2);
  expect(logs.join("")).not.toContain(root);
  expect(logs.some((line) => Number(/lock wait completed in (\d+) ms/.exec(line)?.[1]) >= 30_000)).toBe(true);
  console.info(logs.filter((line) => line.includes("completed")).join(""));
}, 90_000);

it.each([undefined, "", "0", "-1", "NaN", "12.5", "Infinity", "9007199254740992"])(
  "uses a 15-minute default for an invalid wait setting: %s", (value) => {
    expect(directoryMergeLockWaitMs({ PAPERCLIP_RESTORE_LOCK_WAIT_MS: value })).toBe(900_000);
  });
it("reads the wait setting from the caller environment", async () => {
  const { target } = await fixture();
  const env = { ...process.env, PAPERCLIP_RESTORE_LOCK_WAIT_MS: "75" };
  expect(directoryMergeLockWaitMs(env)).toBe(75);
  await withDirectoryMergeLock(target, async () => {
    await expect(withDirectoryMergeLock(target, async () => undefined, env))
      .rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
  });
});

it("acquires an operation slot before the merge lock", async () => {
  const { root, target } = await fixture();
  const baseline = await captureDirectorySnapshot(target);
  const source = path.join(root, "source");
  await mkdir(source);
  const release = deferred(), occupied = [deferred(), deferred()];
  const holders = occupied.map((signal) => sshWorkspaceOperations.run(async () => {
    signal.resolve();
    await release.promise;
  }));
  await Promise.all(occupied.map((signal) => signal.promise));
  const merge = mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target,
    beforeApply: async () => { expect(sshWorkspaceOperations.ownsCurrentSlot()).toBe(true); } });
  try {
    await withDirectoryMergeLock(target, async () => undefined, process.env, undefined, 100);
  } finally { release.resolve(); }
  await Promise.all([...holders, merge]);
});

it("reuses hashes only for unchanged files in the same locally captured target", async () => {
  const { root, target } = await fixture();
  await writeFile(path.join(target, "stable"), "stable");
  await writeFile(path.join(target, "edited"), "before");
  const warm = await captureDirectorySnapshot(target, { diskBacked: true, cacheMetadata: true });
  let counts: unknown;
  try {
    const before = await stat(path.join(target, "edited"));
    await writeFile(path.join(target, "edited"), "after!");
    await utimes(path.join(target, "edited"), before.atime, before.mtime);
    const current = await captureDirectorySnapshot(target, { reuseSnapshot: warm, onScan: (value) => { counts = value; } });
    expect(counts).toEqual({ hashedFiles: 1, reusedFiles: 1 });
    expect(current.entries.get("edited")).toMatchObject({ hash: createHash("sha256").update("after!").digest("hex") });
    const other = path.join(root, "other");
    await cp(target, other, { recursive: true });
    await captureDirectorySnapshot(other, { reuseSnapshot: warm, onScan: (value) => { counts = value; } });
    expect(counts).toEqual({ hashedFiles: 2, reusedFiles: 0 });
    const serialized = serializeDirectorySnapshot(warm);
    if (serialized.version !== 2) throw new Error("Expected disk snapshot");
    const reopened = openDirectorySnapshot(serialized);
    try {
      await captureDirectorySnapshot(target, { reuseSnapshot: reopened, onScan: (value) => { counts = value; } });
      expect(counts).toEqual({ hashedFiles: 2, reusedFiles: 0 });
    } finally { reopened.entries instanceof Map || reopened.entries.close(); }
  } finally { await disposeDirectorySnapshot(warm); }
});

it("invalidates metadata after inode replacement or permission changes", async () => {
  const { target } = await fixture();
  const file = path.join(target, "file");
  await writeFile(file, "old");
  const warm = await captureDirectorySnapshot(target, { diskBacked: true, cacheMetadata: true });
  try {
    await writeFile(path.join(target, "replacement"), "new");
    await rename(path.join(target, "replacement"), file);
    await chmod(file, 0o700);
    let counts: unknown;
    const current = await captureDirectorySnapshot(target, { reuseSnapshot: warm, onScan: (value) => { counts = value; } });
    expect(counts).toEqual({ hashedFiles: 1, reusedFiles: 0 });
    expect(current.entries.get("file")).toMatchObject({ mode: (await stat(file)).mode,
      hash: createHash("sha256").update("new").digest("hex") });
  } finally { await disposeDirectorySnapshot(warm); }
});

it("revalidates changes after the warm scan and rejects conflicts before writing", async () => {
  const { root, target } = await fixture();
  await writeFile(path.join(target, "file"), "before");
  const baseline = await captureDirectorySnapshot(target);
  const source = path.join(root, "source");
  await cp(target, source, { recursive: true });
  await writeFile(path.join(source, "file"), "remote");
  const acquired = deferred(), release = deferred(), waiting = deferred();
  const holder = withDirectoryMergeLock(target, async () => {
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  const beforeApply = vi.fn(async () => {});
  const restore = mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target, conflictPolicy: "reject",
    beforeApply, onProgress: async (line) => { if (line.includes("lock wait started")) waiting.resolve(); } });
  const rejected = expect(restore).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: ["file"] });
  try {
    await waiting.promise;
    await writeFile(path.join(target, "file"), "local!");
  } finally { release.resolve(); }
  await Promise.all([holder, rejected]);
  expect(beforeApply).not.toHaveBeenCalled();
  expect(await readFile(path.join(target, "file"), "utf8")).toBe("local!");
});

it("logs through the restore scope and releases the lock after failures", async () => {
  const { target } = await fixture();
  const lines: string[] = [];
  await expect(withWorkspaceRestoreDiagnostics("workspace", () => withDirectoryMergeLock(target, async () => {
    throw new Error("apply failed");
  }), async (line) => { lines.push(line); })).rejects.toThrow("apply failed");
  expect(lines.some((line) => /lock hold failed in \d+ ms/.test(line))).toBe(true);
  await expect(withDirectoryMergeLock(target, async () => "released", process.env, undefined, 100,
    () => { throw new Error("log unavailable"); })).resolves.toBe("released");
});
