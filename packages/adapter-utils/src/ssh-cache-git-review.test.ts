import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import { readLocalGitWorkspaceSnapshot, transportGitWorkspaceToSsh } from "./ssh-git.js";
import { removeDeletedPathsOnSsh, syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh-sync.js";
import { captureDirectorySnapshot } from "./workspace-directory-snapshot.js";
import { createSshWorkspaceSyncPolicy } from "./ssh-workspace-policy.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

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
const largePaths = (length = 2000) => Array.from({ length }, (_, index) =>
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

  it("preserves a nested clone whose name matches a root exclusion", async () => {
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    await put(local, "source.txt");
    await mkdir(path.join(local, "nested/cache/.git"), { recursive: true });
    await put(local, "nested/cache/data", "local clone");
    const prepared = await prepareRemoteManagedRuntime({
      spec: spec(), runId: "matcher-review", adapterKey: "test", workspaceLocalDir: local,
      workspaceFileMode: "all", workspaceExclude: ["cache"],
    });
    await put(prepared.workspaceRemoteDir, "source.txt", "remote");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "nested/cache/data"), "utf8")).toBe("local clone");
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
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
    const literalPath = "literal\n[cache]*";
    const deletedPaths = [...largePaths(), literalPath, "escape/keep"];
    await put(remote, `${deletedPaths[0]}/data`);
    await symlink("missing", path.join(remote, deletedPaths[1]));
    await put(remote, `${literalPath}/data`);
    await put(root, "outside/keep");
    await symlink(path.join(root, "outside"), path.join(remote, "escape"));
    await removeDeletedPathsOnSsh({ spec: spec(), remoteDir: remote, deletedPaths });
    expect(await readdir(remote)).toEqual(["escape", "source.txt"]);
    expect(await readFile(path.join(root, "outside/keep"), "utf8")).toBe("keep");
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

  it.each(["git", "archive", "discovery"])("supports aggregate-sized %s exclusions", async (operation) => {
    const ignoredPaths = largePaths(30_000);
    const bytes = Buffer.byteLength(ignoredPaths.join("\0"));
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
    if (operation === "git") {
      await repository();
      const snapshot = await readLocalGitWorkspaceSnapshot(local);
      await transportGitWorkspaceToSsh({ spec: spec(), localDir: local, remoteDir: remote,
        snapshot: snapshot!, skippedPaths: ignoredPaths, progressLabel: "workspace" });
      expect(await readFile(path.join(remote, "source.txt"), "utf8")).toBe("keep");
    } else {
      await put(remote, "source.txt", "remote");
      if (operation === "archive") {
        await syncDirectoryFromSsh({ spec: spec(), localDir: local, remoteDir: remote, literalExclude: ignoredPaths });
      } else {
        const baselineSnapshot = await captureDirectorySnapshot(local, { ignoredPaths });
        await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
      }
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    }
  });

  it.each(["upload", "follow", "download"])("preserves literal names and symlinks in large %s lists", async (operation) => {
    const source = operation === "download" ? remote : local;
    const target = operation === "download" ? local : remote;
    const excluded = "private\n[cache]*";
    await put(source, `${excluded}/data`, "excluded");
    await put(source, "privateX[cache]sibling/data", "keep");
    await put(source, "source\nfile", "keep");
    await put(source, "directory/data", "linked");
    await symlink("directory", path.join(source, "link"));
    const literalExclude = [...largePaths(), excluded];
    if (operation === "download") {
      await syncDirectoryFromSsh({ spec: spec(), localDir: target, remoteDir: source, literalExclude });
    } else {
      await syncDirectoryToSsh({ spec: spec(), localDir: source, remoteDir: target, literalExclude,
        followSymlinks: operation === "follow" });
    }
    await expect(lstat(path.join(target, excluded))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(target, "privateX[cache]sibling/data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(target, "source\nfile"), "utf8")).toBe("keep");
    expect(await readFile(path.join(target, "link/data"), "utf8")).toBe("linked");
    if (operation === "follow") expect((await lstat(path.join(target, "link"))).isDirectory()).toBe(true);
    else expect(await readlink(path.join(target, "link"))).toBe("directory");
  });

  it("rejects symlink cycles when a large upload follows links", async () => {
    await symlink(".", path.join(local, "cycle"));
    await expect(syncDirectoryToSsh({ spec: spec(), localDir: local, remoteDir: remote,
      literalExclude: largePaths(), followSymlinks: true })).rejects.toThrow("symlink cycle");
  });

  it.skipIf(process.getuid?.() === 0).each(["literal", "pattern"])(
    "prunes an unreadable %s exclusion before a large archive scan", async (kind) => {
    const blocked = path.join(remote, "private\nwork");
    await put(remote, "source.txt");
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      await syncDirectoryFromSsh({ spec: spec(), localDir: local, remoteDir: remote,
        literalExclude: [...largePaths(), ...(kind === "literal" ? ["private\nwork"] : [])],
        exclude: kind === "pattern" ? ["private*"] : [],
      });
      expect(await readdir(local)).toEqual(["source.txt"]);
      await expect(syncDirectoryFromSsh({ spec: spec(), localDir: local, remoteDir: remote,
        literalExclude: largePaths() })).rejects.toThrow("Cannot read workspace directory");
    } finally { await chmod(blocked, 0o700); }
  });

  it.skipIf(process.getuid?.() === 0)("prunes a newly discovered local clone during the remote scan", async () => {
    await put(local, "source.txt");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "retained", adapterKey: "test",
      workspaceLocalDir: local, workspaceFileMode: "all" });
    await mkdir(path.join(local, "work/.git"), { recursive: true });
    const blocked = path.join(prepared.workspaceRemoteDir, "work/private");
    await mkdir(blocked, { recursive: true });
    await chmod(blocked, 0);
    try {
      await put(prepared.workspaceRemoteDir, "source.txt", "remote");
      await prepared.restoreWorkspace();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    } finally { await chmod(blocked, 0o700).catch(() => {}); }
  });

  it.skipIf(process.getuid?.() === 0)("prunes retained policy paths after a clone marker disappears", async () => {
    await put(local, "source.txt");
    await mkdir(path.join(local, "work/.git"), { recursive: true });
    const syncPolicy = createSshWorkspaceSyncPolicy();
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local, syncPolicy });
    await rm(path.join(local, "work/.git"), { recursive: true });
    const blocked = path.join(local, "work/private");
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      await put(remote, "source.txt", "remote");
      await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, syncPolicy });
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    } finally { await chmod(blocked, 0o700); }
  });
});
