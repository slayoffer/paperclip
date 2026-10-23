import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe("local process sandbox launch directory", () => {
  it.runIf(process.platform === "linux")("starts an owner run in its launch directory and keeps the issue workspace writable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-fs-launch-"));
    cleanup.push(root);
    const workspace = path.join(root, "workspace");
    const launchDir = path.join(root, "owner-session");
    await fs.mkdir(workspace);
    await fs.mkdir(launchDir);
    const build = (cwd: string, options: { launchDir?: string }) => buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd,
      options: { workspaceDir: workspace, filesystemScope: "workspace", ...options },
    });

    await expect(build(launchDir, {})).rejects.toThrow("must be inside workspaceDir");
    const target = await build(launchDir, { launchDir });
    const binds = target.args.flatMap((arg, index) => (arg === "--bind" ? [target.args[index + 1]] : []));
    expect(binds).toEqual(expect.arrayContaining([workspace, launchDir]));
    const chdir = target.args.indexOf("--chdir");
    expect(target.args[chdir + 1]).toBe(launchDir);
    await expect(build(path.join(root, "elsewhere"), { launchDir })).rejects.toThrow("must be inside workspaceDir");
  });
});
