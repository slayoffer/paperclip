import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh.js";
import type { SshRemoteExecutionSpec } from "./ssh-config.js";
import { createSshWorkspaceSyncPolicy } from "./ssh-workspace-policy.js";
import { captureDirectorySnapshot, parseDirectorySnapshot, serializeDirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);

export function registerSshPolicyRestoreTests(fixture: () => {
  local: string; remote: string; root: string; spec: () => SshRemoteExecutionSpec;
}): void {
  it.each(["clone [saved]*", ".scratch-saved"])("retains literal exclusion %s across baseline serialization", async (directory) => {
    const { local, remote, root, spec } = fixture();
    const nestedClone = directory.startsWith("clone");
    await mkdir(path.join(local, directory), { recursive: true });
    await writeFile(path.join(local, directory, "data"), "keep");
    if (nestedClone) await mkdir(path.join(local, directory, ".git"));
    const syncPolicy = createSshWorkspaceSyncPolicy();
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local, syncPolicy });
    const snapshot = await captureDirectorySnapshot(local, {
      ignoredPaths: syncPolicy.excluded.get(local),
    });
    const baselineSnapshot = parseDirectorySnapshot(serializeDirectorySnapshot(snapshot))!;
    if (nestedClone) await rm(path.join(local, directory, ".git"), { recursive: true });
    vi.stubEnv("PAPERCLIP_SSH_SCRATCH_PATTERNS", "[]");
    await mkdir(path.join(remote, directory), { recursive: true });
    await writeFile(path.join(remote, directory, "data"), "remote");
    await writeFile(path.join(root, "bin/ssh"), `#!/usr/bin/env bash
set -eu
script="\${!#}"
if [[ "$script" == *'tar '* ]]; then
  sh -c "$script" > "$SYNC_TEST_ROOT/download.tar"
  cat "$SYNC_TEST_ROOT/download.tar"
else
  exec sh -c "$script"
fi
`);
    await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
    expect(await readFile(path.join(local, directory, "data"), "utf8")).toBe("keep");
    const archive = await exec("tar", ["-tf", path.join(root, "download.tar")]);
    expect(archive.stdout).not.toContain(directory);
  });

  it.skipIf(process.getuid?.() === 0).each(["local", "remote"])(
    "does not scan unreadable caller exclusions during %s restore", async (side) => {
      const { local, spec } = fixture();
      await writeFile(path.join(local, "source.txt"), "local");
      const prepared = await prepareRemoteManagedRuntime({ spec: spec(), runId: "private", adapterKey: "test",
        workspaceLocalDir: local, workspaceFileMode: "all", workspaceExclude: ["private"] });
      const blocked = path.join(side === "local" ? local : prepared.workspaceRemoteDir, "private");
      await mkdir(blocked);
      await chmod(blocked, 0);
      try {
        await writeFile(path.join(prepared.workspaceRemoteDir, "source.txt"), "remote");
        await prepared.restoreWorkspace();
        expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
      } finally {
        await chmod(blocked, 0o700);
      }
    });

  it.skipIf(process.getuid?.() === 0).each(["prepare", "restore"])(
    "keeps skipped paths when size reporting fails during %s", async (phase) => {
      const { local, spec } = fixture();
      await writeFile(path.join(local, "source.txt"), "local");
      const prepared = phase === "restore"
        ? await prepareRemoteManagedRuntime({ spec: spec(), runId: "size", adapterKey: "test", workspaceLocalDir: local })
        : null;
      const blocked = path.join(prepared?.workspaceRemoteDir ?? local, ".scratch-work/node_modules/private");
      await mkdir(blocked, { recursive: true });
      await chmod(blocked, 0);
      try {
        if (prepared) {
          await writeFile(path.join(prepared.workspaceRemoteDir, "source.txt"), "remote");
          await prepared.restoreWorkspace();
          expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
        } else {
          const run = await prepareRemoteManagedRuntime({ spec: spec(), runId: "size", adapterKey: "test", workspaceLocalDir: local });
          expect(await readFile(path.join(run.workspaceRemoteDir, "source.txt"), "utf8")).toBe("local");
        }
      } finally {
        await chmod(blocked, 0o700);
      }
    });

  it.skipIf(process.getuid?.() === 0)("does not scan saved literal exclusions after their clone marker disappears", async () => {
    const { local, remote, spec } = fixture();
    const directory = "clone [saved]*";
    await mkdir(path.join(local, directory, ".git"), { recursive: true });
    await writeFile(path.join(local, directory, "data"), "keep");
    const syncPolicy = createSshWorkspaceSyncPolicy();
    await prepareWorkspaceForSshExecution({ spec: spec(), localDir: local, syncPolicy });
    const snapshot = await captureDirectorySnapshot(local, { ignoredPaths: syncPolicy.excluded.get(local) });
    const baselineSnapshot = parseDirectorySnapshot(serializeDirectorySnapshot(snapshot))!;
    await rm(path.join(local, directory, ".git"), { recursive: true });
    await chmod(path.join(local, directory), 0);
    try {
      await writeFile(path.join(remote, "source.txt"), "remote");
      await restoreWorkspaceFromSshExecution({ spec: spec(), localDir: local, baselineSnapshot });
      expect(await readFile(path.join(local, "source.txt"), "utf8")).toBe("remote");
    } finally {
      await chmod(path.join(local, directory), 0o700);
    }
    expect(await readFile(path.join(local, directory, "data"), "utf8")).toBe("keep");
  });
}
