import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  // Replace an entry after the actual worker reads its type. Only the optional
  // metadata scan races. The source scan and the locked scan use real files.
  const replaceAfterStat = String.raw`
    (() => {
      const { workerData } = require("node:worker_threads");
      if (!workerData.input.cacheMetadata) return;
      const fs = require("node:fs");
      const original = fs.lstatSync;
      let replaced = false;
      fs.lstatSync = (file, options) => {
        const stats = original(file, options);
        if (require("node:path").basename(file) === "victim" && !replaced) {
          replaced = true;
          fs.unlinkSync(file);
          if (process.env.PAPERCLIP_TEST_SCAN_REPLACEMENT === "file-to-symlink-loop") fs.symlinkSync("victim", file);
          else if (stats.isSymbolicLink()) fs.writeFileSync(file, "concurrent result");
          else {
            fs.mkdirSync(file);
            fs.writeFileSync(require("node:path").join(file, "kept"), "concurrent result");
          }
        }
        return stats;
      };
      require("node:module").syncBuiltinESMExports();
    })();
  `;
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(code: string | URL, options?: WorkerOptions) {
        super(typeof code === "string" && options?.eval ? replaceAfterStat + code : code, options);
      }
    },
  };
});

import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["file-to-directory", "symlink-to-file", "file-to-symlink-loop"])(
  "repeats the scan under the lock after a %s replacement", async (replacement) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-scan-race-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_TEST_SCAN_REPLACEMENT", replacement);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
    const target = path.join(root, "target"), source = path.join(root, "source");
    const victim = path.join(target, "victim");
    await mkdir(target);
    if (replacement === "symlink-to-file") await symlink("elsewhere", victim);
    else await writeFile(victim, "baseline");
    const baseline = await captureDirectorySnapshot(target);
    await cp(target, source, { recursive: true, verbatimSymlinks: true });
    await writeFile(path.join(source, "independent"), "incoming result");
    const beforeApply = vi.fn(async () => {
      const current = await lstat(victim);
      expect(current.isDirectory()).toBe(replacement === "file-to-directory");
      expect(current.isSymbolicLink()).toBe(replacement === "file-to-symlink-loop");
    });

    await expect(mergeDirectoryWithBaseline({ baseline, sourceDir: source, targetDir: target,
      conflictPolicy: "reject", beforeApply })).resolves.toBeUndefined();

    expect(beforeApply).toHaveBeenCalledOnce();
    expect(await readFile(path.join(target, "independent"), "utf8")).toBe("incoming result");
    if (replacement === "file-to-symlink-loop") expect(await readlink(victim)).toBe("victim");
    else expect(await readFile(replacement === "file-to-directory" ? path.join(victim, "kept") : victim, "utf8"))
      .toBe("concurrent result");
  }, 30_000,
);
