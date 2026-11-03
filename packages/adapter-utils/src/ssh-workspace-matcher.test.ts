import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { shouldExcludePath } from "./exclude-patterns.js";
import { workspacePathWalkScript } from "./ssh-workspace-path-lists.js";

const exec = promisify(execFile);
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it.each(["cache", "cache/*", "*/cache", "*/cache/*", "private/*", "odd '[*]?\\\n"])(
  "uses baseline exclusion scope and literal text during discovery for %j", async (pattern) => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-matcher-"));
    const directories = ["cache", "nested/cache", "cache-suffix", "nested/cache-suffix",
      "private/child", ".hidden/cache", "._hidden/cache", "odd '[*]?\\\n/leaf"];
    for (const directory of directories) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, ".git"), "gitdir: fixture");
    }
    const scan = exec("sh", ["-s"]);
    scan.child.stdin!.end(workspacePathWalkScript({ root, exclude: [pattern], literal: [], scratchPatterns: [] }));
    const { stdout } = await scan;
    expect(stdout.split("\0").filter(Boolean).map((entry) => entry.slice(2)).sort()).toEqual(
      directories.filter((directory) => !shouldExcludePath(directory, [pattern])).sort(),
    );
  },
);

it.each(["foo/bar", "literal*", "literal[ab]?", "odd '[*]?\\\n"])(
  "uses baseline exclusion scope and literal text during transfer for %j", async (pattern) => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-matcher-"));
    const files = ["foo/bar/data", "nested/foo/bar/data", "literal*/data", "literal-other/data",
      "literal[ab]?/data", "literalaZ/data", "odd '[*]?\\\n/data", "ordinary\nfile"];
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "fixture");
    }
    const scan = exec("sh", ["-s"]);
    scan.child.stdin!.end(workspacePathWalkScript({ root, exclude: [pattern], literal: [] }));
    const { stdout } = await scan;
    const paths = stdout.split("\0").filter(Boolean).map(entry => entry.slice(2));
    expect(paths.filter(entry => files.includes(entry)).sort()).toEqual(
      files.filter(file => !shouldExcludePath(file, [pattern])).sort(),
    );
  },
);
