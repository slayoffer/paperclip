import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import type { SshRemoteExecutionSpec } from "./ssh-config.js";

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
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, ".scratch-tracked/data"), "utf8")).toBe("keep");
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
