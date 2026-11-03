import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreWorkspaceFromSshExecution } from "./ssh.js";
import { readLocalGitWorkspaceSnapshot, transportGitWorkspaceToSsh } from "./ssh-git.js";
import { removeDeletedPathsOnSsh } from "./ssh-sync.js";
import { captureDirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
let root: string;
let local: string;
let remote: string;
const spec = () => ({ host: "fixture", username: "fixture", port: 22,
  remoteWorkspacePath: root, remoteCwd: remote, privateKey: null, knownHosts: null,
  strictHostKeyChecking: false });
async function put(base: string, relative: string, text = "keep") {
  await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
  await writeFile(path.join(base, relative), text);
}
async function repository() {
  await git(local, "init", "-b", "fixture");
  await git(local, "config", "user.name", "Fixture");
  await git(local, "config", "user.email", "fixture@example.invalid");
  await put(local, "source.txt");
  await git(local, "add", ".");
  await git(local, "commit", "-m", "Initial fixture");
}
const largePaths = () => Array.from({ length: 2000 }, (_, index) =>
  `.scratch-${String(index).padStart(4, "0")}-${"x".repeat(70)}`);

describe("SSH cache and Git integration review", { timeout: 60_000 }, () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cache-git-review-"));
    local = path.join(root, "local");
    remote = path.join(root, "remote");
    await mkdir(local);
    await put(root, "bin/ssh", '#!/usr/bin/env bash\nset -eu\nexec sh -c "${!#}"\n');
    await chmod(path.join(root, "bin/ssh"), 0o755);
    vi.stubEnv("PATH", `${path.join(root, "bin")}:${process.env.PATH}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("restores into an absent local destination", async () => {
    await rm(local, { recursive: true });
    await put(remote, "source.txt", "remote");
    await put(remote, ".scratch-work/data");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    expect(await readdir(local)).toEqual(["source.txt"]);
  });

  it("prepares Git workspaces with large literal exclusion lists", async () => {
    await repository();
    const snapshot = await readLocalGitWorkspaceSnapshot(local);
    expect(snapshot).not.toBeNull();
    await transportGitWorkspaceToSsh({ spec: spec(), localDir: local, remoteDir: remote,
      snapshot: snapshot!, skippedPaths: largePaths(), progressLabel: "workspace" });
    expect(await readFile(path.join(remote, "source.txt"), "utf8")).toBe("keep");
  });

  it("removes large literal path lists through stdin", async () => {
    await put(remote, "source.txt");
    const deletedPaths = largePaths();
    await put(remote, `${deletedPaths[0]}/data`);
    await removeDeletedPathsOnSsh({ spec: spec(), remoteDir: remote, deletedPaths });
    expect(await readdir(remote)).toEqual(["source.txt"]);
  });

  it("restores with large newly discovered scratch exclusions", async () => {
    await put(remote, "source.txt", "remote");
    const directories = largePaths();
    expect(directories.reduce((bytes, name) => bytes + Buffer.byteLength(name), 0)).toBeGreaterThan(131_072);
    for (let offset = 0; offset < directories.length; offset += 100) {
      await Promise.all(directories.slice(offset, offset + 100).map((name) =>
        mkdir(path.join(remote, name))));
    }
    await put(remote, `${directories[0]}/data`, "excluded");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, onProgress: async () => {} });
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    expect(await readdir(local)).toEqual(["source.txt"]);
  });

  it("restores a baseline with large saved literal exclusions", async () => {
    await put(local, "source.txt");
    await put(remote, "source.txt", "remote");
    const baselineSnapshot = await captureDirectorySnapshot(local, { ignoredPaths: largePaths() });
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
  });
});
