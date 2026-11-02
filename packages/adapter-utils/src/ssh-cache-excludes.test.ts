import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const kinds = ["node_modules", ".pnpm-store", ".turbo", ".next", ".cache", "__pycache__", ".venv", "target", "odd [cache]*"];
const tagged = (kind: string) => kind === "target" || kind === "odd [cache]*";
let root: string;
let local: string;
let remote: string;
const spec = () => ({ host: "fixture", username: "fixture", port: 22, remoteWorkspacePath: root,
  remoteCwd: remote, privateKey: null, knownHosts: null, strictHostKeyChecking: false });
async function put(base: string, relative: string, text: string) {
  await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
  await writeFile(path.join(base, relative), text);
}
async function cache(base: string, kind: string, text: string, prefix = "app/") {
  await put(base, `${prefix}${kind}/data`, text);
  if (tagged(kind)) await put(base, `${prefix}${kind}/CACHEDIR.TAG`, "Signature: 8a477f597d28d172789f06886806bc55\n");
}
async function repository(cwd: string, linked = false) {
  if (linked) {
    const seed = `${cwd}-seed`;
    await repository(seed);
    await git(seed, "worktree", "add", "-b", "linked-fixture", cwd);
    return;
  }
  await mkdir(cwd, { recursive: true });
  await git(cwd, "init", "-b", "fixture");
  await git(cwd, "config", "user.name", "Fixture");
  await git(cwd, "config", "user.email", "fixture@example.invalid");
  await put(cwd, ".gitignore", "node_modules/\n.cache/\n");
  await put(cwd, "source.txt", "original");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "Initial fixture");
}

describe("SSH cache exclusions", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cache-test-"));
    local = path.join(root, "local");
    remote = path.join(root, "remote");
    await mkdir(local);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    // Only SSH is substituted. Production shell scripts, Git, tar, and merges run unchanged.
    await put(bin, "ssh", '#!/usr/bin/env bash\nset -eu\nexec sh -c "${!#}"\n');
    await chmod(path.join(bin, "ssh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it.each(["git", "worktree", "plain", "all", "referenced-git", "referenced-plain"])("checks the measured transfer matrix: %s", async (mode) => {
    const source = mode.startsWith("referenced") ? path.join(root, "reference") : local;
    await mkdir(source, { recursive: true });
    if (mode.includes("git") || mode === "all" || mode === "worktree") await repository(source, mode === "worktree");
    for (const kind of ["node_modules", ".cache", "target"]) await cache(source, kind, "local");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "matrix", adapterKey: "test",
      workspaceLocalDir: local, ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}),
      additionalSources: mode.startsWith("referenced")
        ? [{ localPath: source, projectId: "reference", ignoreResolution: await resolveReferencedSourceIgnore(source) }] : [],
    });
    const destination = prepared.additionalSourceDirs.reference ?? prepared.workspaceRemoteDir;
    const result: Record<string, { prepare: boolean; restore: boolean | null }> = {};
    for (const kind of ["node_modules", ".cache", "target"]) {
      result[kind] = { prepare: await stat(path.join(destination, `app/${kind}/data`)).then(() => true, () => false), restore: null };
      await cache(destination, kind, "remote");
    }
    await prepared.restoreWorkspace();
    for (const kind of ["node_modules", ".cache", "target"]) {
      const value = await readFile(path.join(source, `app/${kind}/data`), "utf8");
      if (mode.startsWith("referenced")) expect(value).toBe("local");
      else result[kind]!.restore = value === "remote";
    }
    const restore = mode.startsWith("referenced") ? null : false;
    expect(result).toEqual({
      node_modules: { prepare: false, restore },
      ".cache": { prepare: false, restore },
      target: { prepare: false, restore },
    });
  });

  for (const mode of ["git", "worktree", "plain", "all", "referenced-git", "referenced-plain"] as const) {
    it.each(kinds)(`prepare excludes %s, mode=${mode}`, async (kind) => {
      const source = mode.startsWith("referenced") ? path.join(root, "reference") : local;
      await mkdir(source, { recursive: true });
      if (mode.includes("git") || mode === "all" || mode === "worktree") await repository(source, mode === "worktree");
      for (const prefix of ["", "app/"]) await cache(source, kind, "local", prefix);
      await put(source, "source.txt", "keep");
      await put(source, "docs/target/data", "not a cache");
      const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "prepare", adapterKey: "test",
        workspaceLocalDir: local, ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}),
        additionalSources: mode.startsWith("referenced")
          ? [{ localPath: source, projectId: "reference", ignoreResolution: await resolveReferencedSourceIgnore(source) }] : [],
      });
      const destination = prepared.additionalSourceDirs.reference ?? prepared.workspaceRemoteDir;
      for (const prefix of ["", "app/"]) {
        await expect(stat(path.join(destination, `${prefix}${kind}`))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(path.join(destination, "source.txt"), "utf8")).toBe("keep");
      expect(await readFile(path.join(destination, "docs/target/data"), "utf8")).toBe("not a cache");
    });
  }

  for (const mode of ["git", "worktree", "plain", "all", "direct-git", "direct-plain"] as const) {
    it.each(kinds)(`restore preserves %s, mode=${mode}`, async (kind) => {
      if (mode.includes("git") || mode === "all" || mode === "worktree") await repository(local, mode === "worktree");
      await cache(local, kind, "local");
      await cache(local, kind, "local absent remotely", "absent/");
      await put(local, "source.txt", "original");
      const prepared = mode.startsWith("direct") ? null : await prepareRemoteManagedRuntime({ spec: spec(),
        runId: "restore", adapterKey: "test", workspaceLocalDir: local,
        ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}),
      });
      if (!prepared) await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
      const destination = prepared?.workspaceRemoteDir ?? remote;
      await rm(path.join(destination, "absent"), { recursive: true, force: true });
      await cache(destination, kind, "remote");
      await cache(destination, kind, "new remote cache", "new/");
      // The local marker protects the directory even if the remote marker disappears.
      if (tagged(kind)) await rm(path.join(destination, `app/${kind}/CACHEDIR.TAG`));
      await put(destination, "source.txt", "remote source");
      if (prepared) await prepared.restoreWorkspace();
      else await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
      expect(await readFile(path.join(local, `app/${kind}/data`), "utf8")).toBe("local");
      expect(await readFile(path.join(local, `absent/${kind}/data`), "utf8")).toBe("local absent remotely");
      await expect(stat(path.join(local, `new/${kind}`))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote source");
    });
  }

  it.each(["local", "remote"])("preserves directories tagged after prepare on the %s", async (side) => {
    await put(local, "app/cache/data", "local");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "late-tag", adapterKey: "test", workspaceLocalDir: local });
    await put(prepared.workspaceRemoteDir, "app/cache/data", "remote");
    await put(side === "local" ? local : prepared.workspaceRemoteDir, "app/cache/CACHEDIR.TAG", "");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "app/cache/data"), "utf8")).toBe("local");
  });

  it("preserves a tagged directory when the remote replaces its parent", async () => {
    await cache(local, "target", "keep");
    await put(local, "app/source.txt", "source");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "parent", adapterKey: "test", workspaceLocalDir: local });
    await rm(path.join(prepared.workspaceRemoteDir, "app"), { recursive: true });
    await put(prepared.workspaceRemoteDir, "app", "replacement");
    await expect(prepared.restoreWorkspace()).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT" });
    expect(await readFile(path.join(local, "app/target/data"), "utf8")).toBe("keep");
  });

  it("excludes a tagged workspace root and preserves its local contents", async () => {
    await put(local, "CACHEDIR.TAG", "");
    await put(local, "data", "keep");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "root", adapterKey: "test", workspaceLocalDir: local });
    await expect(stat(path.join(prepared.workspaceRemoteDir, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    await put(prepared.workspaceRemoteDir, "data", "remote");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "data"), "utf8")).toBe("keep");
  });

  it("does not treat a directory named CACHEDIR.TAG as a cache marker", async () => {
    await put(local, "target/CACHEDIR.TAG/source", "keep");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "false-tag", adapterKey: "test", workspaceLocalDir: local });
    expect(await readFile(path.join(prepared.workspaceRemoteDir, "target/CACHEDIR.TAG/source"), "utf8")).toBe("keep");
  });

  it("restores into a local directory that does not exist", async () => {
    await put(remote, "source.txt", "remote source");
    await cache(remote, "target", "remote cache");
    const destination = path.join(root, "new-local");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: destination });
    expect(await readFile(path.join(destination, "source.txt"), "utf8")).toBe("remote source");
    await expect(stat(path.join(destination, "app/target"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
