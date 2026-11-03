import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSshWorkspaceSnapshot } from "./ssh-cache-directories.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { createSshWorkspaceSyncPolicy } from "./ssh-workspace-policy.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
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

    it.each(["local", "remote"])("rejects an unreadable %s directory outside the exclusions", async (side) => {
      await put(local, "source.txt");
      const prepared = await prepare();
      await block(path.join(side === "local" ? local : prepared.workspaceRemoteDir, "blocked"));
      await put(prepared.workspaceRemoteDir, "source.txt", "remote");
      await expect(prepared.restoreWorkspace()).rejects.toThrow();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("keep");
    });
  });

  describe.skipIf(process.getuid?.() === 0)("combined cache and scratch exclusions", () => {
    it.each(["prepare", "restore"])("prunes unreadable cache children during %s", async (phase) => {
      await put(local, "source.txt");
      const prepared = phase === "restore" ? await prepare() : null;
      const target = prepared?.workspaceRemoteDir ?? local;
      await put(target, "target/CACHEDIR.TAG", "");
      await block(path.join(target, "target/private"));
      const run = prepared ?? await prepare();
      await put(run.workspaceRemoteDir, "source.txt", "remote");
      await run.restoreWorkspace();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    });

    it("prunes unreadable scratch children before cache discovery on restore", async () => {
      await put(local, "source.txt");
      const prepared = await prepare();
      await block(path.join(prepared.workspaceRemoteDir, ".scratch-new/private"));
      await put(prepared.workspaceRemoteDir, "source.txt", "remote");
      await prepared.restoreWorkspace();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    });

    it("prunes a newly discovered local clone during the remote scan", async () => {
      await put(local, "source.txt");
      const prepared = await prepare();
      await mkdir(path.join(local, "work/.git"), { recursive: true });
      await block(path.join(prepared.workspaceRemoteDir, "work/private"));
      await put(prepared.workspaceRemoteDir, "source.txt", "remote");
      await prepared.restoreWorkspace();
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    });

    it("prunes retained policy paths after a clone marker disappears", async () => {
      await put(local, "source.txt");
      await mkdir(path.join(local, "work/.git"), { recursive: true });
      const syncPolicy = createSshWorkspaceSyncPolicy();
      await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local, syncPolicy });
      await rm(path.join(local, "work/.git"), { recursive: true });
      await block(path.join(local, "work/private"));
      await put(remote, "source.txt", "remote");
      await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, syncPolicy });
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    });

    it("does not scan children of a tagged workspace root", async () => {
      await put(local, "CACHEDIR.TAG", "");
      await block(path.join(local, "private"));
      const prepared = await prepare();
      await prepared.restoreWorkspace();
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

  it.each(["cache", "odd [cache]*"])("retains the literal %s cache across snapshot serialization", async (directory) => {
    await put(local, `${directory}/CACHEDIR.TAG`, "");
    await put(local, `${directory}/data`);
    const snapshot = await captureSshWorkspaceSnapshot(local, { exclude: [] });
    const baselineSnapshot = parseDirectorySnapshot(serializeDirectorySnapshot(snapshot))!;
    await rm(path.join(local, directory, "CACHEDIR.TAG"));
    await put(remote, `${directory}/data`, "remote");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, directory, "data"), "utf8")).toBe("keep");
  });

  it.each(["../outside", "/outside", "", 12])("rejects invalid serialized ignored path %j", (entry) => {
    expect(parseDirectorySnapshot({ version: 1, exclude: [], entries: [], ignoredPaths: [entry] })).toBeNull();
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

  it("preserves nested tagged cache data with a root-relative cache exclusion", async () => {
    await put(local, "nested/cache/CACHEDIR.TAG", "");
    await put(local, "nested/cache/data");
    const prepared = await prepare(["cache"]);
    await expect(readFile(path.join(prepared.workspaceRemoteDir, "nested/cache/data")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "nested/cache/data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(local, "nested/cache/CACHEDIR.TAG"), "utf8")).toBe("");
  });

  it.each(["local", "remote"].flatMap((side) =>
    ["", ".paperclip-repositories"].map((ancestor) => ({ side, ancestor }))))(
    "protects nested repositories when $side ancestor '$ancestor' gains a tag", async ({ side, ancestor }) => {
    const repository = ".paperclip-repositories/child";
    await put(local, `${repository}/data`);
    const baselineSnapshot = await captureSshWorkspaceSnapshot(local, { exclude: [".paperclip-repositories"] });
    const repositoryBaseline = await captureSshWorkspaceSnapshot(path.join(local, repository), { exclude: [] });
    await put(remote, `${repository}/data`, "remote");
    await put(side === "local" ? local : remote, path.join(ancestor, "CACHEDIR.TAG"), "");
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot,
      repositories: [{ path: repository, baselineSnapshot: repositoryBaseline }],
    });
    expect(await readFile(path.join(local, `${repository}/data`), "utf8")).toBe("keep");
  });

  it.each(["", ".paperclip-repositories"])("does not upload nested repository files under tagged ancestor '%s'", async (ancestor) => {
    const repository = ".paperclip-repositories/child";
    for (const directory of [local, path.join(local, repository)]) {
      await put(directory, "source.txt");
      await exec("git", ["init", "-b", "fixture", directory]);
      await exec("git", ["-C", directory, "add", "source.txt"]);
      await exec("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "-m", "Initial fixture"]);
    }
    await put(local, `${repository}/untracked-data`, "cache");
    await put(local, path.join(ancestor, "CACHEDIR.TAG"), "");
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "tagged-git-root",
      adapterKey: "test", workspaceLocalDir: local });
    await expect(readFile(path.join(prepared.workspaceRemoteDir, repository, "untracked-data")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains remote cache names split inside a UTF-8 character", async () => {
    await put(local, "café/data");
    const prepared = await prepare();
    await put(prepared.workspaceRemoteDir, "café/CACHEDIR.TAG", "");
    await put(prepared.workspaceRemoteDir, "café/data", "remote");
    const fragmenter = path.join(root, "fragment-ssh.mjs");
    await writeFile(fragmenter, `import { spawn } from "node:child_process";
const child = spawn("sh", ["-c", process.argv.at(-1)], { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(child.stdin);
const chunks = [];
child.stdout.on("data", (chunk) => chunks.push(chunk));
child.on("close", (code) => {
  const output = Buffer.concat(chunks);
  const index = output.indexOf(Buffer.from("é"));
  if (index < 0) { process.stdout.write(output); process.exitCode = code; return; }
  process.stdout.write(output.subarray(0, index + 1));
  setTimeout(() => { process.stdout.write(output.subarray(index + 1)); process.exitCode = code; }, 30);
});
`);
    await writeFile(path.join(root, "bin/ssh"), `#!/usr/bin/env bash\nexec "${process.execPath}" "${fragmenter}" "$@"\n`);
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "café/data"), "utf8")).toBe("keep");
  });

  it("restores with cache exclusions larger than one process argument", async () => {
    await put(local, "source.txt");
    const prepared = await prepare();
    const directories = Array.from({ length: 2000 }, (_, index) =>
      `cache-${String(index).padStart(4, "0")}-${"x".repeat(70)}`);
    expect(directories.reduce((bytes, name) => bytes + Buffer.byteLength(name), 0)).toBeGreaterThan(131_072);
    for (let offset = 0; offset < directories.length; offset += 100) {
      await Promise.all(directories.slice(offset, offset + 100).map((name) =>
        put(prepared.workspaceRemoteDir, `${name}/CACHEDIR.TAG`, "")));
    }
    await put(prepared.workspaceRemoteDir, `${directories[0]}/data`, "cache");
    await put(prepared.workspaceRemoteDir, "source.txt", "remote");
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    expect((await readdir(local)).sort()).toEqual(["source.txt"]);
  }, 60_000);

  it("restores a baseline with large saved literal exclusions", async () => {
    await put(local, "source.txt");
    await put(remote, "source.txt", "remote");
    const ignoredPaths = Array.from({ length: 2000 }, (_, index) =>
      `cache-${String(index).padStart(4, "0")}-${"x".repeat(70)}`);
    const baselineSnapshot = await captureSshWorkspaceSnapshot(local, { exclude: [], ignoredPaths });
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
  });

  it("uploads a referenced project with 6000 resolved ignore paths", async () => {
    const reference = path.join(root, "reference");
    await put(reference, "source.txt");
    await exec("git", ["init", reference]);
    await put(reference, ".gitignore", "ignored-*.tmp\n");
    const names = Array.from({ length: 6000 }, (_, index) =>
      `ignored-${String(index).padStart(4, "0")}-${"x".repeat(68)}.tmp`);
    expect(names.reduce((bytes, name) => bytes + Buffer.byteLength(name), 0)).toBe(510_000);
    for (let offset = 0; offset < names.length; offset += 100) {
      await Promise.all(names.slice(offset, offset + 100).map((name) => writeFile(path.join(reference, name), "ignored")));
    }
    const ignoreResolution = await resolveReferencedSourceIgnore(reference);
    expect(ignoreResolution.kind).toBe("git");
    if (ignoreResolution.kind !== "git") throw new Error("Git ignore resolution failed");
    expect(ignoreResolution.ignoredPaths).toHaveLength(6000);
    expect(ignoreResolution.ignoredPaths.reduce((bytes, entry) => bytes + Buffer.byteLength(entry), 0)).toBe(510_000);
    const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "large-ignore", adapterKey: "test",
      workspaceLocalDir: local, additionalSources: [{ localPath: reference, projectId: "source", ignoreResolution }],
    });
    expect(prepared.additionalSourceDirs.source).toBeDefined();
    const destination = prepared.additionalSourceDirs.source!;
    expect(await readFile(path.join(destination, "source.txt"), "utf8")).toBe("keep");
    expect((await readdir(destination)).sort()).toEqual([".gitignore", "source.txt"]);
  }, 60_000);
});
