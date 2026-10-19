import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
let root: string;
let local: string;
let remote: string;
const spec = () => ({ host: "fixture", username: "fixture", port: 22, remoteWorkspacePath: root,
  remoteCwd: remote, privateKey: null, knownHosts: null, strictHostKeyChecking: false });

// Execute the production SSH shell scripts locally. Tar and Git remain real subprocesses.
// Corruption keeps a valid bundle header, so Git detects a truncated pack, not an invalid format.
const sshShim = `#!/usr/bin/env bash
set -eu
script="${"${!#}"}"
if [[ "$script" == *'bundle create'* && "$script" == *'export-'* ]]; then
  printf 'export\\n' >> "$SYNC_TEST_ROOT/exports"
  if [[ "${"${SYNC_TEST_CORRUPT:-}"}" == always || ( "${"${SYNC_TEST_CORRUPT:-}"}" == once && ! -e "$SYNC_TEST_ROOT/corrupted" ) ]]; then
    touch "$SYNC_TEST_ROOT/corrupted"
    sh -c "$script" > "$SYNC_TEST_ROOT/full.bundle"
    head -c 180 "$SYNC_TEST_ROOT/full.bundle"
    exit 0
  fi
fi
exec sh -c "$script"
`;

describe("SSH workspace sync regressions", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-sync-regression-"));
    local = path.join(root, "local");
    remote = path.join(root, "remote");
    const bin = path.join(root, "bin");
    await mkdir(local);
    await mkdir(bin);
    await writeFile(path.join(bin, "ssh"), sshShim);
    await chmod(path.join(bin, "ssh"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("SYNC_TEST_ROOT", root);
    vi.stubEnv("SYNC_TEST_CORRUPT", "");
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  async function repository() {
    await git(local, "init", "-b", "fixture");
    await git(local, "config", "user.name", "Fixture");
    await git(local, "config", "user.email", "fixture@example.invalid");
    await writeFile(path.join(local, "source.txt"), "initial\n");
    await git(local, "add", ".");
    await git(local, "commit", "-m", "Initial fixture");
  }

  it.each(["plain", "all", "git"] as const)("excludes generated files in both directions and preserves local copies, mode=%s", async (mode) => {
    if (mode === "git") await repository();
    const generated = ["node_modules/pkg/data", "app/node_modules/pkg/data", "dist/output", "app/build/output",
      "out/output", "coverage/output", ".next/output", ".turbo/output", ".cache/output"];
    for (const relative of generated) {
      await mkdir(path.dirname(path.join(local, relative)), { recursive: true });
      await writeFile(path.join(local, relative), "local dependency");
    }
    await writeFile(path.join(local, "source.txt"), "initial\n");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "fixture", adapterKey: "test", workspaceLocalDir: local,
      ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}) });
    const remoteRoot = prepared.workspaceRemoteDir;
    for (const relative of generated) await expect(stat(path.join(remoteRoot, relative))).rejects.toMatchObject({ code: "ENOENT" });
    for (const relative of generated) {
      await mkdir(path.dirname(path.join(remoteRoot, relative)), { recursive: true });
      await writeFile(path.join(remoteRoot, relative), "remote dependency");
    }
    await writeFile(path.join(remoteRoot, "source.txt"), "remote edit\n");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote edit\n");
    for (const relative of generated) expect(await readFile(path.join(local, relative), "utf8")).toBe("local dependency");
  });

  it("keeps tracked relative link text and a clean Git status after a round trip", async () => {
    await repository();
    await mkdir(path.join(local, ".claude", "skills"), { recursive: true });
    await symlink("../../source.txt", path.join(local, ".claude", "skills", "paperclip"));
    await git(local, "add", ".");
    await git(local, "commit", "-m", "Add relative link");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "links", adapterKey: "test", workspaceLocalDir: local });
    expect(await readlink(path.join(prepared.workspaceRemoteDir, ".claude/skills/paperclip"))).toBe("../../source.txt");
    await prepared.restoreWorkspace();
    expect(await readlink(path.join(local, ".claude/skills/paperclip"))).toBe("../../source.txt");
    expect(await git(local, "status", "--porcelain")).toBe("");
  });

  it("preserves nested local dependencies during a direct restore without a supplied baseline", async () => {
    await mkdir(path.join(local, "app/node_modules/pkg"), { recursive: true });
    await writeFile(path.join(local, "app/node_modules/pkg/data"), "keep");
    await writeFile(path.join(local, "old.txt"), "remove");
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    await rm(path.join(remote, "app"), { recursive: true, force: true });
    await writeFile(path.join(remote, "new.txt"), "new");
    await rm(path.join(remote, "old.txt"));
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
    expect(await readFile(path.join(local, "app/node_modules/pkg/data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(local, "new.txt"), "utf8")).toBe("new");
    await expect(stat(path.join(local, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(
    ["direct", "direct-git", "managed", "all", "git"].flatMap((restorePath) =>
      ["file", "symlink"].flatMap((replacement) =>
        ["node_modules", "dist"].map((excluded) => ({ restorePath, replacement, excluded })))),
  )("rejects unsafe $replacement replacements with $excluded, restore=$restorePath", async ({ restorePath, replacement, excluded }) => {
    if (restorePath === "git" || restorePath === "direct-git") await repository();
    const dependency = path.join(local, "app", excluded, "pkg/data");
    await mkdir(path.dirname(dependency), { recursive: true });
    await writeFile(dependency, "local dependency");
    await writeFile(path.join(local, "app/source.txt"), "local source");
    await writeFile(path.join(local, "00-first.txt"), "local first");
    await writeFile(path.join(local, "deleted.txt"), "local deleted");
    if (restorePath === "direct-git") {
      await writeFile(path.join(local, ".gitignore"), `${excluded}/\n`);
      await git(local, "add", ".");
      await git(local, "commit", "-m", "Track parent and ignore generated data");
    }
    const prepared = restorePath.startsWith("direct") ? null : await prepareRemoteManagedRuntime({
      spec: spec(), runId: "replacement", adapterKey: "test", workspaceLocalDir: local,
      ...(restorePath === "all" ? { workspaceFileMode: "all" as const } : {}),
    });
    if (!prepared) await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    const remoteRoot = prepared?.workspaceRemoteDir ?? remote;
    await rm(path.join(remoteRoot, "app"), { recursive: true, force: true });
    if (replacement === "file") await writeFile(path.join(remoteRoot, "app"), "remote replacement");
    else await symlink("00-first.txt", path.join(remoteRoot, "app"));
    await writeFile(path.join(remoteRoot, "00-first.txt"), "remote first");
    await rm(path.join(remoteRoot, "deleted.txt"));
    const localHead = restorePath.includes("git") ? await git(local, "rev-parse", "HEAD") : null;
    if (restorePath.includes("git")) {
      await git(remoteRoot, "add", ".");
      await git(remoteRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Replace parent");
    }
    const restore = prepared ? prepared.restoreWorkspace() : restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
    await expect(restore).rejects.toMatchObject({ code: "DIRECTORY_MERGE_CONFLICT", paths: [`app/${excluded}`] });
    expect(await readFile(dependency, "utf8")).toBe("local dependency");
    expect(await readFile(path.join(local, "app/source.txt"), "utf8")).toBe("local source");
    expect(await readFile(path.join(local, "00-first.txt"), "utf8")).toBe("local first");
    expect(await readFile(path.join(local, "deleted.txt"), "utf8")).toBe("local deleted");
    if (localHead) expect(await git(local, "rev-parse", "HEAD")).toBe(localHead);
  });

  it.each(["file", "symlink"])("restores a safe direct Git %s replacement without a baseline", async (replacement) => {
    await repository();
    await mkdir(path.join(local, "app"));
    await writeFile(path.join(local, "app/source.txt"), "tracked source");
    await git(local, "add", ".");
    await git(local, "commit", "-m", "Track parent");
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    await rm(path.join(remote, "app"), { recursive: true });
    if (replacement === "file") await writeFile(path.join(remote, "app"), "safe replacement");
    else await symlink("source.txt", path.join(remote, "app"));
    await git(remote, "add", ".");
    await git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Replace parent");
    const remoteHead = await git(remote, "rev-parse", "HEAD");
    await writeFile(path.join(remote, "source.txt"), "dirty remote edit");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
    expect(await git(local, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("dirty remote edit");
    if (replacement === "file") expect(await readFile(path.join(local, "app"), "utf8")).toBe("safe replacement");
    else expect(await readlink(path.join(local, "app"))).toBe("source.txt");
    expect(await git(local, "for-each-ref", "refs/paperclip/ssh-sync/imported")).toBe("");
  });

  it("preserves a concurrent local directory when the remote file did not change", async () => {
    await writeFile(path.join(local, "app"), "unchanged remote file");
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    const baselineSnapshot = await captureDirectorySnapshot(local, { exclude: [...SSH_WORKSPACE_EXCLUDES] });
    await rm(path.join(local, "app"));
    await mkdir(path.join(local, "app/node_modules/pkg"), { recursive: true });
    await writeFile(path.join(local, "app/node_modules/pkg/data"), "concurrent dependency");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, "app/node_modules/pkg/data"), "utf8")).toBe("concurrent dependency");
  });

  it.each(["once", "always"])("re-exports a truncated bundle once, corruption=%s", async (corruption) => {
    await repository();
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    await writeFile(path.join(remote, "source.txt"), "committed remote edit\n");
    await git(remote, "add", ".");
    await git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Remote edit");
    const baselineSnapshot = await captureDirectorySnapshot(local, { exclude: [".git", ".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES] });
    vi.stubEnv("SYNC_TEST_CORRUPT", corruption);
    const restore = restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot, restoreGitHistory: true });
    if (corruption === "once") {
      await restore;
      expect(await git(local, "rev-parse", "HEAD")).toBe(await git(remote, "rev-parse", "HEAD"));
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("committed remote edit\n");
    } else {
      await expect(restore).rejects.toThrow(/early EOF|index-pack/);
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("initial\n");
    }
    expect((await readFile(path.join(root, "exports"), "utf8")).trim().split("\n")).toHaveLength(2);
  });
});
