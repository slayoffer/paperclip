import path from "node:path";
import { captureSshWorkspaceSnapshot } from "./ssh-cache-directories.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { sshRuntimeIsolationScript } from "./ssh-runtime-isolation.js";
import { linkSshProviderSessionScript, sshProviderSessionDirectories } from "./ssh-provider-sessions.js";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import { scheduleSshWorkspaceOperation, timeWorkspaceStep } from "./workspace-operation-schedule.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  ...SSH_WORKSPACE_EXCLUDES,
  ...["vendor", ".git"].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]),
];

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export function prepareRemoteManagedRuntime(input: Parameters<typeof prepareRemoteManagedRuntimeInner>[0]): Promise<PreparedRemoteManagedRuntime> {
  return scheduleSshWorkspaceOperation(input.onProgress, "prepare", () => prepareRemoteManagedRuntimeInner(input));
}

async function prepareRemoteManagedRuntimeInner(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  companyId?: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  /**
   * Explicit host folder for the runtime assets of this run. Use it only for a
   * folder that belongs to this run alone (SSH `in_place`): `restoreWorkspace`
   * removes it after the asset restore hooks ran. Without it, the root stays
   * `<workspaceRemoteDir>/.paperclip-runtime/<adapterKey>` and nothing removes it.
   */
  runtimeRootDir?: string | null;
  providerSessionRoot?: string;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const workspaceRemoteDir = syncWorkspace
    ? path.posix.join(
        baseWorkspaceRemoteDir,
        ".paperclip-runtime",
        "runs",
        input.runId,
        "workspace",
      )
    : baseWorkspaceRemoteDir;
  const explicitRuntimeRootDir = input.runtimeRootDir?.trim() || null;
  if (explicitRuntimeRootDir && !path.posix.isAbsolute(explicitRuntimeRootDir)) {
    throw new Error(`Remote runtime root is not an absolute path: ${explicitRuntimeRootDir}`);
  }
  const runtimeRootDir = explicitRuntimeRootDir ??
    path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const providerSessions = explicitRuntimeRootDir || input.providerSessionRoot ? sshProviderSessionDirectories({
    runtimeRoot: runtimeRootDir,
    providerSessionRoot: input.providerSessionRoot,
    adapterKey: input.adapterKey,
    companyId: input.companyId,
    workspace: workspaceRemoteDir,
    assetKeys: (input.assets ?? []).map((asset) => asset.key),
  }) : [];
  if (explicitRuntimeRootDir) {
    // Check the host view before any credential or configuration upload.
    await runSshCommand(input.spec, sshRuntimeIsolationScript(workspaceRemoteDir,
      [explicitRuntimeRootDir,
        ...(input.assets ?? []).map((asset) => path.posix.join(explicitRuntimeRootDir, asset.key)),
        ...providerSessions.map((session) => session.directory)]),
    { timeoutMs: 30_000 });
  }
  // Remove the per-run runtime folder. Run it after the asset restore hooks,
  // because a hook can read a file from the folder (Codex auth copy-back).
  // The parent `runs/<runId>` folder is removed only when it is empty.
  const removeExplicitRuntimeRoot = async () => {
    if (!explicitRuntimeRootDir) return;
    await runSshCommand(
      input.spec,
      `rm -rf -- ${shellQuote(explicitRuntimeRootDir)} && (rmdir -- ${shellQuote(path.posix.dirname(explicitRuntimeRootDir))} 2>/dev/null || true)`,
      { timeoutMs: 60_000 },
    );
  };

  const preparedWorkspace = syncWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
      })
    : null;
  const projectRepositories = preparedWorkspace?.repositories ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await timeWorkspaceStep(input.onProgress, "Workspace baseline", () => captureSshWorkspaceSnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          ? [
              ...GIT_ARCHIVE_EXCLUDES,
              ...SSH_WORKSPACE_EXCLUDES,
              ".paperclip-runtime",
              ...(projectRepositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : []),
            ]
          : [".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES, ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
      }))
    : null;
  const repositoryBaselines: Array<{ path: string; baselineSnapshot: DirectorySnapshot }> = [];
  for (const repository of projectRepositories) {
    repositoryBaselines.push({
      path: repository,
      baselineSnapshot: await timeWorkspaceStep(input.onProgress, "Repository baseline", () => captureSshWorkspaceSnapshot(path.join(input.workspaceLocalDir, repository), {
        exclude: [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES],
      })),
    });
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      const sessionExcludes = providerSessions.filter((session) => session.assetKey === asset.key)
        .flatMap((session) => [session.name, `${session.name}/*`]);
      assetDirs[asset.key] = remoteDir;
      await timeWorkspaceStep(input.onProgress, `Asset ${asset.key} sync`, () => syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: sessionExcludes.length ? [...(asset.exclude ?? []), ...sessionExcludes] : asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      }));
      for (const session of providerSessions.filter((session) => session.assetKey === asset.key)) {
        await runSshCommand(input.spec,
          linkSshProviderSessionScript(path.posix.join(remoteDir, session.name), session.directory),
          { timeoutMs: 30_000 });
      }
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
        repositories: repositoryBaselines,
      });
    }
    await removeExplicitRuntimeRoot().catch(() => undefined);
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await timeWorkspaceStep(input.onProgress, "Referenced project sync", () => syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
        excludeTaggedCaches: true,
      }));
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: (onProgress?: RuntimeProgressSink) => scheduleSshWorkspaceOperation(onProgress, "restore", async () => {
      if (preparedWorkspace && baselineSnapshot) {
        await restoreWorkspaceFromSshExecution({
          spec: input.spec,
          localDir: input.workspaceLocalDir,
          remoteDir: workspaceRemoteDir,
          baselineSnapshot,
          restoreGitHistory: preparedWorkspace.gitBacked,
          onProgress,
          repositories: repositoryBaselines,
        });
      }
      try {
        for (const asset of input.assets ?? []) {
          if (!asset.restore) continue;
          await asset.restore({
            assetDir: path.posix.join(runtimeRootDir, asset.key),
            readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
          });
        }
      } finally {
        // Cleanup is best effort: a stale run folder must not fail the run.
        await removeExplicitRuntimeRoot().catch((error) => {
          console.warn(`[paperclip] Failed to remove run runtime folder ${explicitRuntimeRootDir}: ${String(error)}`);
        });
      }
    }),
  };
}
