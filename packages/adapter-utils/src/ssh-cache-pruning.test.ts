import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { parseTaggedCacheDirectories, taggedCacheScanScript } from "./ssh-cache-directories.js";
import { shouldExcludePath } from "./exclude-patterns.js";

const exec = promisify(execFile);
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it.each([
  { label: "workspace", directory: "packages", exclude: ["packages"], ignored: [] },
  { label: "reference vendor", directory: "vendor", exclude: ["vendor"], ignored: [] },
  { label: "Git ignored", directory: "ignored [cache]*", exclude: [], ignored: ["ignored [cache]*"] },
])("does not enter a $label excluded tree", async ({ directory, exclude, ignored }) => {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cache-prune-"));
  for (let index = 0; index < 32; index++) {
    const leaf = path.join(root, directory, `visited-${index}`);
    await mkdir(leaf, { recursive: true });
    await writeFile(path.join(leaf, "CACHEDIR.TAG"), "cache");
  }
  await mkdir(path.join(root, "allowed"));
  await writeFile(path.join(root, "allowed/CACHEDIR.TAG"), "cache");
  // Trace the real scan, before TypeScript filters its output. A traversal must
  // not even enumerate the children of an excluded directory.
  const scan = exec("sh", ["-x", "-s"], { maxBuffer: 4 * 1024 * 1024 });
  scan.child.stdin!.end(taggedCacheScanScript(root, exclude, ignored));
  const { stdout, stderr } = await scan;
  expect(stdout).toContain("T./allowed\0");
  expect((stdout + stderr).match(/visited-\d+/g) ?? []).toHaveLength(0);
});

it.each(["cache", "cache/*", "*/cache", "*/cache/*", "private/*", "odd '[*]?\\\n"])(
  "uses the shared matcher scope and literal text for %j", async (pattern) => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cache-matcher-"));
    const directories = ["cache", "nested/cache", "cache-suffix", "nested/cache-suffix",
      "private/child", ".hidden/cache", "odd '[*]?\\\n/leaf"];
    for (const directory of directories) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "CACHEDIR.TAG"), "cache");
    }
    const scan = exec("sh", ["-s"]);
    scan.child.stdin!.end(taggedCacheScanScript(root, [pattern]));
    const { stdout } = await scan;
    // Do not filter the records here: the traversal itself must use the matcher.
    expect(parseTaggedCacheDirectories(stdout).sort()).toEqual(
      directories.filter((directory) => !shouldExcludePath(directory, [pattern])).sort(),
    );
  },
);
