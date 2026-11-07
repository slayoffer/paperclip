import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { updateGitHeadAndIndex } from "./ssh-git-index.js";
import { exportGitWorkspaceFromSsh, integrateImportedGitHead, readLocalGitWorkspaceSnapshot } from "./ssh-git.js";

const exec = promisify(execFile);
it("does not export a parent repository from a folder without Git metadata", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-git-boundary-")));
  try {
    await exec("git", ["init", "-b", "main", root]);
    await writeFile(path.join(root, "source.txt"), "parent source");
    await exec("git", ["-C", root, "add", "source.txt"]);
    await exec("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Initial fixture"]);
    const child = path.join(root, ".paperclip", "worktrees", "missing-link");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(child, "local.txt"), "local");
    expect(await readLocalGitWorkspaceSnapshot(child)).toBeNull();
    const index = await readFile(path.join(root, ".git", "index"));
    const spec = { host: "must-not-connect.invalid", username: "fixture", port: 22, remoteWorkspacePath: "/unused",
      remoteCwd: "/unused", privateKey: null, knownHosts: null, strictHostKeyChecking: false };
    await expect(exportGitWorkspaceFromSsh({ spec, localDir: child, remoteDir: "/unused" })).rejects.toThrow();
    await expect(integrateImportedGitHead({ localDir: child, importedHead: "HEAD" })).rejects.toThrow("no Git checkout");
    await expect(updateGitHeadAndIndex(child, "refs/heads/main", "HEAD", "HEAD")).rejects.toThrow();
    expect(await readFile(path.join(root, ".git", "index"))).toEqual(index);
    expect(await readLocalGitWorkspaceSnapshot(root)).toMatchObject({ branchName: "main" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
