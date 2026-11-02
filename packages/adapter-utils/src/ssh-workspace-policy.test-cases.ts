import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution, syncDirectoryToSsh } from "./ssh.js";
import type { SshRemoteExecutionSpec } from "./ssh-config.js";
import { estimateLocalDirSize } from "./ssh-transfer-progress.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";
import { WorkspaceManifestWriter, type WorkspacePaths } from "./workspace-manifest.js";
import { removeDeletedPathsOnSsh } from "./ssh-sync.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

export function registerSshWorkspacePolicyTests(fixture: () => {
  local: string; remote: string; root: string;
  spec: () => SshRemoteExecutionSpec; repository: () => Promise<void>;
}): void {
  it.each(["plain", "all", "git"] as const)("skips scratch directories and nested repositories in both directions, mode=%s", async (mode) => {
    const { local, remote, spec, repository } = fixture();
    if (mode !== "plain") await repository();
    const skipped = ["clone", "deep/clone with spaces", ".scratch-local", "deep/.cto-local"];
    for (const relative of skipped) {
      await mkdir(path.join(local, relative), { recursive: true });
      await writeFile(path.join(local, relative, "data"), "keep local");
    }
    await git(path.join(local, "clone"), "init");
    await writeFile(path.join(local, "deep/clone with spaces/.git"), "gitdir: /unused\n");
    await writeFile(path.join(local, "source.txt"), "initial\n");
    const logs: string[] = [];
    const onProgress = (line: string) => { logs.push(line); };
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "scratch", adapterKey: "test",
      workspaceLocalDir: local, onProgress, ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}) });
    for (const relative of skipped) await expect(stat(path.join(prepared.workspaceRemoteDir, relative))).rejects.toMatchObject({ code: "ENOENT" });
    for (const relative of [...skipped, "remote-clone", ".scratch-remote", "deep/.cto-remote"]) {
      await mkdir(path.join(prepared.workspaceRemoteDir, relative), { recursive: true });
      await writeFile(path.join(prepared.workspaceRemoteDir, relative, "data"), "remote scratch");
    }
    await git(path.join(prepared.workspaceRemoteDir, "remote-clone"), "init");
    await writeFile(path.join(prepared.workspaceRemoteDir, "source.txt"), "remote edit\n");
    await prepared.restoreWorkspace(onProgress);
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote edit\n");
    for (const relative of skipped) expect(await readFile(path.join(local, relative, "data"), "utf8")).toBe("keep local");
    for (const relative of ["remote-clone", ".scratch-remote", "deep/.cto-remote"]) {
      await expect(stat(path.join(local, relative))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const skipLogs = logs.filter((line) => line.includes("Skipped SSH workspace path"));
    expect(skipLogs).toHaveLength(7);
    for (const relative of skipped) {
      expect(skipLogs.filter((line) => line.includes(JSON.stringify(relative)))).toHaveLength(1);
    }
    expect(skipLogs.every((line) => /size=\d+ KiB/.test(line))).toBe(true);
    if (mode !== "plain") expect(await git(local, "rev-parse", "HEAD")).toBeTruthy();
  });

  it.each(["clone", ".scratch-keep"].flatMap((skipped) =>
    ["absolute", "relative"].map((target) => ({ skipped, target }))))(
    "preserves external files behind a committed ancestor symlink, skipped=$skipped target=$target", async ({ skipped, target }) => {
      const { local, remote, root, spec, repository } = fixture();
      await repository();
      const outside = path.join(root, "outside");
      await mkdir(path.join(outside, skipped), { recursive: true });
      await writeFile(path.join(outside, skipped, "data"), "external sentinel");
      await mkdir(path.join(local, "parent"));
      await symlink(target === "absolute" ? outside : "../../outside", path.join(local, "parent/link"));
      await git(local, "add", ".");
      await git(local, "commit", "-m", "Track ancestor symlink");
      await rm(path.join(local, "parent/link"));
      await mkdir(path.join(local, "parent/link", skipped), { recursive: true });
      if (skipped === "clone") await mkdir(path.join(local, "parent/link", skipped, ".git"));
      await writeFile(path.join(local, "parent/link", skipped, "data"), "local scratch");
      await writeFile(path.join(local, "parent/link/source.txt"), "ordinary source");
      await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
      expect(await readFile(path.join(outside, skipped, "data"), "utf8")).toBe("external sentinel");
      expect(await readFile(path.join(remote, "parent/link/source.txt"), "utf8")).toBe("ordinary source");
      await expect(stat(path.join(remote, "parent/link", skipped))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(local, "parent/link", skipped, "data"), "utf8")).toBe("local scratch");
    });

  it("removes literal paths and leaf symlinks but skips unsafe ancestors", async () => {
    const { remote, root, spec } = fixture();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "child"), { recursive: true });
    await writeFile(path.join(outside, "child/data"), "external sentinel");
    await mkdir(remote);
    await symlink(outside, path.join(remote, "ancestor"));
    await symlink(outside, path.join(remote, "leaf"));
    await symlink(path.join(root, "absent"), path.join(remote, "dangling"));
    await writeFile(path.join(remote, "file"), "non-directory ancestor");
    const literal = "-parent'\n*/child?[x]";
    await mkdir(path.join(remote, literal), { recursive: true });
    await writeFile(path.join(remote, literal, "data"), "remove");
    await writeFile(path.join(remote, "keep"), "keep");
    await removeDeletedPathsOnSsh({ spec: spec(), remoteDir: remote,
      deletedPaths: ["ancestor/child", "dangling/child", "file/child", "missing/child", "leaf", literal] });
    expect(await readFile(path.join(outside, "child/data"), "utf8")).toBe("external sentinel");
    expect((await lstat(path.join(remote, "ancestor"))).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(remote, "dangling"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(remote, "file"), "utf8")).toBe("non-directory ancestor");
    expect(await readFile(path.join(remote, "keep"), "utf8")).toBe("keep");
    for (const removed of ["leaf", literal]) {
      await expect(lstat(path.join(remote, removed))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["", ".", "..", "../outside", "/outside", "a/../outside", "a//b", "a/", "a/./b", "a\0b"])(
    "rejects unsafe removal paths before deleting anything: %j", async (invalid) => {
      const { remote, spec } = fixture();
      await mkdir(remote);
      await writeFile(path.join(remote, "keep"), "keep");
      await expect(removeDeletedPathsOnSsh({ spec: spec(), remoteDir: remote,
        deletedPaths: ["keep", invalid] })).rejects.toThrow("Invalid workspace removal path");
      expect(await readFile(path.join(remote, "keep"), "utf8")).toBe("keep");
    });

  it("uses configured scratch patterns in both directions", async () => {
    const { local, remote, root, spec, repository } = fixture();
    vi.stubEnv("PAPERCLIP_SSH_SCRATCH_PATTERNS", '["temp-*"]');
    await mkdir(path.join(local, "temp-local"));
    await writeFile(path.join(local, "temp-local/data"), "keep");
    await mkdir(path.join(local, ".scratch-included"));
    await writeFile(path.join(local, ".scratch-included/data"), "include");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "patterns", adapterKey: "test", workspaceLocalDir: local });
    await expect(stat(path.join(prepared.workspaceRemoteDir, "temp-local"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(prepared.workspaceRemoteDir, ".scratch-included/data"), "utf8")).toBe("include");
    await mkdir(path.join(prepared.workspaceRemoteDir, "temp-remote"));
    await writeFile(path.join(prepared.workspaceRemoteDir, "temp-remote/data"), "omit");
    await prepared.restoreWorkspace();
    await expect(stat(path.join(local, "temp-remote"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(local, "temp-local/data"), "utf8")).toBe("keep");
  });

  it("excludes literal directory names without excluding similar source paths", async () => {
    const { local, remote, root, spec, repository } = fixture();
    const names = ["clone[1]*?", "clone'quoted\nline"];
    for (const name of names) {
      await mkdir(path.join(local, name, ".git"), { recursive: true });
      await writeFile(path.join(local, name, "data"), "keep");
    }
    await mkdir(path.join(local, "clone1source"));
    await writeFile(path.join(local, "clone1source/data"), "source");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "literal", adapterKey: "test", workspaceLocalDir: local });
    for (const name of names) await expect(stat(path.join(prepared.workspaceRemoteDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(prepared.workspaceRemoteDir, "clone1source/data"), "utf8")).toBe("source");
    await mkdir(path.join(prepared.workspaceRemoteDir, "remote[2]*?/.git"), { recursive: true });
    await prepared.restoreWorkspace();
    await expect(stat(path.join(local, "remote[2]*?"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of names) expect(await readFile(path.join(local, name, "data"), "utf8")).toBe("keep");
  });

  it.each(["plain", "all", "git", "direct", "direct-git", "baseline-array", "baseline-manifest"])(
    "restores sibling edits beside a literal star clone, mode=%s", async (mode) => {
      const { local, remote, root, spec, repository } = fixture();
      if (mode.includes("git") || mode === "all") await repository();
      await mkdir(path.join(local, "foo"));
      await writeFile(path.join(local, "foo/source.txt"), "initial");
      if (mode.includes("git") || mode === "all") {
        await git(local, "add", "foo/source.txt");
        await git(local, "commit", "-m", "Track sibling source");
      }
      await mkdir(path.join(local, "foo/*/.git"), { recursive: true });
      await writeFile(path.join(local, "foo/*/data"), "keep clone");
      await writeFile(path.join(local, "protected.txt"), "keep ignored");
      const direct = mode.startsWith("direct") || mode.startsWith("baseline");
      const prepared = direct ? null : await prepareRemoteManagedRuntime({
        spec: spec(), runId: "literal-star", adapterKey: "test", workspaceLocalDir: local,
        ...(mode === "all" ? { workspaceFileMode: "all" as const } : {}),
      });
      if (direct) await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
      let ignoredPaths: WorkspacePaths = ["protected.txt"];
      if (mode === "baseline-manifest") {
        const writer = new WorkspaceManifestWriter(path.join(root, "ignored.sqlite"));
        writer.add("ignored", "protected.txt");
        ignoredPaths = writer.paths("ignored");
        writer.close();
      }
      const baselineSnapshot = mode.startsWith("baseline")
        ? await captureDirectorySnapshot(local, { ignoredPaths }) : undefined;
      try {
        const remoteRoot = prepared?.workspaceRemoteDir ?? remote;
        await expect(stat(path.join(remoteRoot, "foo/*"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(remoteRoot, "foo/source.txt"), "utf8")).toBe("initial");
        await writeFile(path.join(remoteRoot, "foo/source.txt"), "remote edit");
        await writeFile(path.join(remoteRoot, "protected.txt"), "remote ignored edit");
        if (prepared) await prepared.restoreWorkspace();
        else await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
        expect(await readFile(path.join(local, "foo/source.txt"), "utf8")).toBe("remote edit");
        expect(await readFile(path.join(local, "foo/*/data"), "utf8")).toBe("keep clone");
        if (baselineSnapshot) {
          expect(await readFile(path.join(local, "protected.txt"), "utf8")).toBe("keep ignored");
        }
      } finally { await disposeDirectorySnapshot(baselineSnapshot ?? null); }
    });

  it.each(["plain", "git"])("preserves skipped paths during a direct restore, mode=%s", async (mode) => {
    const { local, remote, spec, repository } = fixture();
    if (mode === "git") await repository();
    await mkdir(path.join(local, "clone/.git"), { recursive: true });
    await writeFile(path.join(local, "clone/data"), "keep");
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local });
    await mkdir(path.join(remote, "new-clone/.git"), { recursive: true });
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local });
    expect(await readFile(path.join(local, "clone/data"), "utf8")).toBe("keep");
    await expect(stat(path.join(local, "new-clone"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps explicit tar patterns separate from literal paths with the same spelling", async () => {
    const { local, remote, spec } = fixture();
    await mkdir(path.join(local, "foo/*"), { recursive: true });
    await writeFile(path.join(local, "foo/*/data"), "clone contents");
    await writeFile(path.join(local, "foo/source.txt"), "source");
    expect(await estimateLocalDirSize({ localDir: local, literalExclude: ["foo/*"] })).toBe(6);
    await syncDirectoryToSsh({ spec: spec(), localDir: local, remoteDir: remote,
      exclude: ["foo/*"], literalExclude: ["foo/*"] });
    await expect(stat(path.join(remote, "foo/source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(remote, "foo/*"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a baseline directory when the remote turns it into a clone", async () => {
    const { local, remote, root, spec, repository } = fixture();
    await mkdir(path.join(local, "work"));
    await writeFile(path.join(local, "work/data"), "keep");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "new-clone", adapterKey: "test", workspaceLocalDir: local });
    await mkdir(path.join(prepared.workspaceRemoteDir, "work/.git"));
    await writeFile(path.join(prepared.workspaceRemoteDir, "work/data"), "skip");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "work/data"), "utf8")).toBe("keep");
    await expect(stat(path.join(local, "work/.git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows an empty scratch list but still excludes nested clones and leaves assets unchanged", async () => {
    const { local, remote, root, spec, repository } = fixture();
    vi.stubEnv("PAPERCLIP_SSH_SCRATCH_PATTERNS", "[]");
    await mkdir(path.join(local, ".scratch-source"));
    await writeFile(path.join(local, ".scratch-source/data"), "include");
    await mkdir(path.join(local, "clone/.git"), { recursive: true });
    const asset = path.join(root, "asset");
    await mkdir(path.join(asset, "nested/.git"), { recursive: true });
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "empty", adapterKey: "test",
      workspaceLocalDir: local, assets: [{ key: "asset", localDir: asset }] });
    expect(await readFile(path.join(prepared.workspaceRemoteDir, ".scratch-source/data"), "utf8")).toBe("include");
    await expect(stat(path.join(prepared.workspaceRemoteDir, "clone"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(prepared.assetDirs.asset!, "nested/.git"))).isDirectory()).toBe(true);
    await prepared.restoreWorkspace();
  });

  it("omits tracked scratch files from the transported working tree", async () => {
    const { local, remote, root, spec, repository } = fixture();
    await repository();
    await mkdir(path.join(local, ".scratch-tracked"));
    await writeFile(path.join(local, ".scratch-tracked/data"), "keep");
    await git(local, "add", ".");
    await git(local, "commit", "-m", "Track scratch fixture");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "tracked", adapterKey: "test", workspaceLocalDir: local });
    await expect(stat(path.join(prepared.workspaceRemoteDir, ".scratch-tracked"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(prepared.workspaceRemoteDir, "source.txt"), "remote commit\n");
    await git(prepared.workspaceRemoteDir, "add", "-A");
    await git(prepared.workspaceRemoteDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Remote source edit");
    expect(await git(prepared.workspaceRemoteDir, "show", "HEAD:.scratch-tracked/data")).toBe("keep");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, ".scratch-tracked/data"), "utf8")).toBe("keep");
    expect(await git(local, "show", "HEAD:.scratch-tracked/data")).toBe("keep");
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote commit\n");
    expect(await git(local, "status", "--porcelain")).toBe("");
  });

  it.each(['{}', '["path/child"]', '[7]'])("rejects invalid scratch configuration %s", async (configured) => {
    const { local, remote, spec } = fixture();
    vi.stubEnv("PAPERCLIP_SSH_SCRATCH_PATTERNS", configured);
    await expect(prepareRemoteManagedRuntime({ spec: spec(), runId: "invalid", adapterKey: "test", workspaceLocalDir: local }))
      .rejects.toThrow("PAPERCLIP_SSH_SCRATCH_PATTERNS");
    await expect(stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
  });

}
