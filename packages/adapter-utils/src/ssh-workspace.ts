import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { cacheDirectoryTarExcludes, localTaggedCacheDirectories, parseTaggedCacheDirectories, taggedCacheScanScript, withTaggedCacheDirectories } from "./ssh-cache-directories.js";
import { workspacePaths } from "./workspace-manifest.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import type { DirectorySnapshot } from "./workspace-restore-merge.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import { scheduleSshWorkspaceOperation, timeWorkspaceStep } from "./workspace-operation-schedule.js";
import { type RuntimeProgressSink } from "./runtime-progress.js";
import { type SshRemoteExecutionSpec } from "./ssh-config.js";
import { runLocalGit, runSshScript } from "./ssh-command.js";
import { clearRemoteDirectory, syncDirectoryToSsh, syncDirectoryFromSsh } from "./ssh-sync.js";
import {
  readLocalGitWorkspaceSnapshot,
  exportGitWorkspaceFromSsh,
  integrateImportedGitHead,
  PROJECT_REPOSITORY_NAME_PATTERN,
  listLocalProjectRepositories,
  transportGitWorkspaceToSsh,
  excludeProjectRepositoriesOnSsh,
} from "./ssh-git.js";

export function prepareWorkspaceForSshExecution(input: Parameters<typeof prepareWorkspaceForSshExecutionInner>[0]): Promise<{ gitBacked: boolean; repositories?: string[] }> {
  return scheduleSshWorkspaceOperation(input.onProgress, "prepare", () => prepareWorkspaceForSshExecutionInner(input));
}

async function prepareWorkspaceForSshExecutionInner(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  onProgress?: RuntimeProgressSink;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
}): Promise<{ gitBacked: boolean; repositories?: string[] }> {
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const gitSnapshot = input.workspaceFileMode === "all" ? null : await timeWorkspaceStep(
    input.onProgress, "Git snapshot", () => readLocalGitWorkspaceSnapshot(input.localDir),
  );

  if (gitSnapshot) {
    const repositories = await listLocalProjectRepositories(input.localDir);
    await transportGitWorkspaceToSsh({
      spec: input.spec,
      localDir: input.localDir,
      remoteDir,
      snapshot: gitSnapshot,
      exclude: repositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : [],
      onProgress: input.onProgress,
      progressLabel: "workspace",
    });
    if (repositories.length > 0) {
      await excludeProjectRepositoriesOnSsh(input.spec, remoteDir);
    }
    for (const relative of repositories) {
      const localDir = path.join(input.localDir, relative);
      const snapshot = await readLocalGitWorkspaceSnapshot(localDir);
      if (!snapshot) throw new Error(`Cannot read the Git state of project repository: ${relative}`);
      await transportGitWorkspaceToSsh({
        spec: input.spec,
        localDir,
        remoteDir: path.posix.join(remoteDir, relative),
        snapshot,
        onProgress: input.onProgress,
        progressLabel: relative,
      });
    }
    return { gitBacked: true, ...(repositories.length > 0 ? { repositories } : {}) };
  }

  await clearRemoteDirectory({
    spec: input.spec,
    remoteDir,
    preserveEntries: [".paperclip-runtime"],
  });
  await timeWorkspaceStep(input.onProgress, "Workspace sync", () => syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    exclude: [".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES, ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
    excludeTaggedCaches: true,
    onProgress: input.onProgress,
    progressLabel: "workspace",
  }));
  return { gitBacked: false };
}

export function restoreWorkspaceFromSshExecution(input: Parameters<typeof restoreWorkspaceFromSshExecutionInner>[0]): Promise<void> {
  return scheduleSshWorkspaceOperation(input.onProgress, "restore", () => restoreWorkspaceFromSshExecutionInner(input));
}

async function restoreWorkspaceFromSshExecutionInner(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir?: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  repositories?: Array<{ path: string; baselineSnapshot?: DirectorySnapshot }>;
}): Promise<void> {
  if (input.baselineSnapshot?.exclude.includes(".")) return;
  const remoteDir = input.remoteDir ?? input.spec.remoteCwd;
  const repositories = input.repositories ?? [];
  for (const repository of repositories) {
    if (
      path.posix.dirname(repository.path) !== PROJECT_REPOSITORIES_DIR ||
      !PROJECT_REPOSITORY_NAME_PATTERN.test(path.posix.basename(repository.path))
    ) {
      throw new Error(`Invalid project repository path: ${repository.path}`);
    }
    if (input.baselineSnapshot && !repository.baselineSnapshot) {
      throw new Error(`Project repository has no workspace baseline: ${repository.path}`);
    }
  }
  if (
    input.baselineSnapshot &&
    repositories.length > 0 &&
    !input.baselineSnapshot.exclude.includes(PROJECT_REPOSITORIES_DIR)
  ) {
    throw new Error(`Workspace baseline must exclude ${PROJECT_REPOSITORIES_DIR} when project repositories are restored separately`);
  }
  for (const repository of repositories) {
    await restoreWorkspaceRootFromSsh({
      spec: input.spec,
      localDir: path.join(input.localDir, repository.path),
      remoteDir: path.posix.join(remoteDir, repository.path),
      baselineSnapshot: repository.baselineSnapshot,
      restoreGitHistory: input.restoreGitHistory,
      onProgress: input.onProgress,
      progressLabel: repository.path,
    });
  }
  await restoreWorkspaceRootFromSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir,
    baselineSnapshot: input.baselineSnapshot,
    restoreGitHistory: input.restoreGitHistory,
    onProgress: input.onProgress,
    progressLabel: "workspace",
    hasProjectRepositories: repositories.length > 0,
  });
}

async function restoreWorkspaceRootFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  baselineSnapshot?: DirectorySnapshot;
  restoreGitHistory?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
  hasProjectRepositories?: boolean;
}): Promise<void> {
  const remoteDir = input.remoteDir;
  if (input.baselineSnapshot?.exclude.includes(".")) return;
  const scanExclude = [
    ...(input.baselineSnapshot?.exclude ?? [".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES]),
    ...cacheDirectoryTarExcludes([...workspacePaths(input.baselineSnapshot?.ignoredPaths ?? [])]),
  ];
  const tagged = [...new Set([
    ...await localTaggedCacheDirectories(input.localDir, scanExclude),
    ...parseTaggedCacheDirectories((await runSshScript(input.spec, taggedCacheScanScript(remoteDir, scanExclude), {
      timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024,
    })).stdout),
  ])];
  if (tagged.includes(".")) return;
  // Direct Git restores need the same preflight as managed restores. Fetching
  // objects is safe, but resetting the working tree would remove excluded data.
  const gitSnapshot = input.baselineSnapshot ? null : await readLocalGitWorkspaceSnapshot(input.localDir);
  const capturedBaseline = input.baselineSnapshot ?? (gitSnapshot
    ? await captureDirectorySnapshot(input.localDir, {
      exclude: [".git", ".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES,
        ...(input.hasProjectRepositories ? [PROJECT_REPOSITORIES_DIR] : [])],
      ignoredPaths: tagged,
    })
    : null);
  const baseline = capturedBaseline ? withTaggedCacheDirectories(capturedBaseline, tagged) : null;
  const restoreGitHistory = gitSnapshot !== null || input.restoreGitHistory;
  if (baseline) {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
    const importedRef = restoreGitHistory
      ? `refs/paperclip/ssh-sync/imported/${randomUUID()}`
      : null;
    try {
      const importedHead = restoreGitHistory
        ? await exportGitWorkspaceFromSsh({
          spec: input.spec,
          remoteDir,
          localDir: input.localDir,
          importedRef: importedRef ?? undefined,
          resetLocalWorkspace: false,
          onProgress: input.onProgress,
        })
        : null;
      await syncDirectoryFromSsh({
        spec: input.spec,
        remoteDir,
        localDir: stagingDir,
        exclude: baseline.exclude,
        excludedCacheDirectories: baseline.ignoredPaths,
        onProgress: input.onProgress,
        progressLabel: input.progressLabel,
      });
      await mergeDirectoryWithBaseline({
        baseline,
        sourceDir: stagingDir,
        targetDir: input.localDir,
        onProgress: input.onProgress,
        // Git history advances via integrateImportedGitHead; the working tree
        // still comes from the remote file snapshot so dirty remote edits win.
        beforeApply: importedHead
          ? async () => {
            await integrateImportedGitHead({
              localDir: input.localDir,
              importedHead,
            });
          }
          : undefined,
      });
    } finally {
      if (importedRef) {
        await runLocalGit(input.localDir, ["--git-dir", path.join(input.localDir, ".git"), "update-ref", "-d", importedRef], {
          timeout: 10_000,
          maxBuffer: 16 * 1024,
        }).catch(() => undefined);
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (!input.baselineSnapshot) await disposeDirectorySnapshot(capturedBaseline);
    }
    return;
  }

  await syncDirectoryFromSsh({
    spec: input.spec,
    remoteDir,
    localDir: input.localDir,
    exclude: [".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES],
    excludedCacheDirectories: tagged,
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  });
}
