import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSshWorkspaceSnapshot } from "./ssh-cache-directories.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { restoreWorkspaceFromSshExecution } from "./ssh.js";
import { parseDirectorySnapshot, serializeDirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);
let root: string;
let local: string;
let remote: string;
let unreadable: string[];
const spec = () => ({ host: "fixture", username: "fixture", port: 22,
  remoteWorkspacePath: root, remoteCwd: remote, privateKey: null, knownHosts: null,
  strictHostKeyChecking: false });
async function put(base: string, relative: string, text = "keep") {
  await mkdir(path.dirname(path.join(base, relative)), { recursive: true });
  await writeFile(path.join(base, relative), text);
}
async function block(directory: string) {
  await mkdir(directory, { recursive: true });
  unreadable.push(directory);
  await chmod(directory, 0);
  await expect(readdir(directory)).rejects.toMatchObject({ code: "EACCES" });
}
const prepare = (workspaceExclude: string[] = []) => prepareRemoteManagedRuntime({
  spec: spec(), runId: "review", adapterKey: "test", workspaceLocalDir: local,
  workspaceFileMode: "all", workspaceExclude,
});

describe("SSH cache review regressions", { timeout: 30_000 }, () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-cache-review-"));
    local = path.join(root, "local");
    remote = path.join(root, "remote");
    unreadable = [];
    await mkdir(local);
    await put(root, "bin/ssh", '#!/usr/bin/env bash\nset -eu\nexec sh -c "${!#}"\n');
    await chmod(path.join(root, "bin/ssh"), 0o755);
    vi.stubEnv("PATH", `${path.join(root, "bin")}:${process.env.PATH}`);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const directory of unreadable) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  });

  describe.skipIf(process.getuid?.() === 0)("caller exclusions", () => {
    it.each(["blocked", "private/blocked", "*/blocked"])("prunes workspace exclusion %s during prepare", async (exclude) => {
      await put(local, "source.txt");
      await block(path.join(local, exclude === "*/blocked" ? "nested/blocked" : exclude));
      const prepared = await prepare([exclude]);
      expect(await readFile(path.join(prepared.workspaceRemoteDir, "source.txt"), "utf8")).toBe("keep");
    });

    it("prunes caller exclusions during baseline capture", async () => {
      await put(local, "source.txt");
      await block(path.join(local, "private/blocked"));
      const snapshot = await captureSshWorkspaceSnapshot(local, { exclude: ["private/blocked"] });
      expect([...snapshot.entries].map(([relative]) => relative).sort()).toEqual(["private", "source.txt"]);
    });

    it.each(["local", "remote"])("prunes %s exclusions during restore", async (side) => {
      await put(local, "source.txt");
      const prepared = await prepare(["private/blocked"]);
      await block(path.join(side === "local" ? local : prepared.workspaceRemoteDir, "private/blocked"));
      await put(prepared.workspaceRemoteDir, "source.txt", "remote");
      await prepared.restoreWorkspace();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    });

    it.each(["vendor", "ignored [cache]*"])("prunes referenced-project exclusion %s", async (excluded) => {
      const reference = path.join(root, "reference");
      await put(reference, "source.txt");
      await exec("git", ["init", reference]);
      await put(reference, ".gitignore", "ignored \\[cache\\]\\*/\n");
      await put(reference, `${excluded}/data`);
      const ignoreResolution = await resolveReferencedSourceIgnore(reference);
      expect(ignoreResolution.kind).toBe("git");
      await block(path.join(reference, excluded));
      const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "reference", adapterKey: "test",
        workspaceLocalDir: local, additionalSources: [{ localPath: reference, projectId: "source", ignoreResolution }],
      });
      expect(prepared.additionalSourceDirs.source).toBeDefined();
      expect(await readFile(path.join(prepared.additionalSourceDirs.source!, "source.txt"), "utf8")).toBe("keep");
    });
  });

  it("preserves a tagged root after its local marker is removed", async () => {
    await put(local, "CACHEDIR.TAG", "");
    await put(local, "data");
    const prepared = await prepare();
    await rm(path.join(local, "CACHEDIR.TAG"));
    await put(prepared.workspaceRemoteDir, "data", "remote");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "data"), "utf8")).toBe("keep");
  });

  it("retains root exclusion across snapshot serialization", async () => {
    await put(local, "CACHEDIR.TAG", "");
    await put(local, "data");
    const snapshot = await captureSshWorkspaceSnapshot(local, { exclude: [] });
    const baselineSnapshot = parseDirectorySnapshot(serializeDirectorySnapshot(snapshot))!;
    await rm(path.join(local, "CACHEDIR.TAG"));
    await put(remote, "data", "remote");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, "data"), "utf8")).toBe("keep");
  });

  it("skips nested repository restores when their workspace root was tagged", async () => {
    const repository = ".paperclip-repositories/child";
    await put(local, "CACHEDIR.TAG", "");
    await put(local, `${repository}/data`);
    const baselineSnapshot = await captureSshWorkspaceSnapshot(local, { exclude: [".paperclip-repositories"] });
    const repositoryBaseline = await captureSshWorkspaceSnapshot(path.join(local, repository), { exclude: [] });
    await rm(path.join(local, "CACHEDIR.TAG"));
    await put(remote, `${repository}/data`, "remote");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot,
      repositories: [{ path: repository, baselineSnapshot: repositoryBaseline }],
    });
    expect(await readFile(path.join(local, `${repository}/data`), "utf8")).toBe("keep");
  });
});
