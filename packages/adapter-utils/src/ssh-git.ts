import { updateGitHeadAndIndex } from "./ssh-git-index.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createUnrelatedHistoryGraftCommit,
  GIT_SYNC_COMMIT_IDENTITY_ARGS,
  PROJECT_REPOSITORIES_DIR,
  readSanitizedOriginRemoteUrl,
} from "./git-workspace-sync.js";
import { timeWorkspaceStep } from "./workspace-operation-schedule.js";
import { type RuntimeProgressSink } from "./runtime-progress.js";
import {
  type SshConnectionConfig,
  type SshRemoteExecutionSpec,
  type LocalGitWorkspaceSnapshot,
  shellQuote,
} from "./ssh-config.js";
import { runLocalGit as runLocalGitCommand, runSshScript } from "./ssh-command.js";
import { createTransferProgress, streamLocalFileToSsh, streamSshToLocalFile } from "./ssh-transfer-progress.js";
import { removeDeletedPathsOnSsh, syncDirectoryToSsh } from "./ssh-sync.js";

// Bind every Git operation to this checkout. Missing metadata must never trigger
// discovery of a parent repository, including between validation and restore.
function runLocalGit(localDir: string, args: string[], options?: Parameters<typeof runLocalGitCommand>[2]) {
  return runLocalGitCommand(localDir,
    ["--git-dir", path.join(localDir, ".git"), "--work-tree", localDir, ...args], options);
}

export async function readLocalGitWorkspaceSnapshot(localDir: string): Promise<LocalGitWorkspaceSnapshot | null> {
  try {
    if (!await isLocalGitRepositoryRoot(localDir)) return null;
    const insideWorkTree = await runLocalGit(localDir, ["rev-parse", "--is-inside-work-tree"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (insideWorkTree.stdout.trim() !== "true") {
      return null;
    }

    const [headCommitResult, branchResult, deletedResult] = await Promise.all([
      runLocalGit(localDir, ["rev-parse", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }),
      runLocalGit(localDir, ["ls-files", "--deleted", "-z"], {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      }),
    ]);

    const branchName = branchResult.stdout.trim();
    return {
      headCommit: headCommitResult.stdout.trim(),
      branchName: branchName && branchName !== "HEAD" ? branchName : null,
      deletedPaths: deletedResult.stdout
        .split("\0")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function importGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  onProgress?: RuntimeProgressSink;
}): Promise<void> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  // Per-import unique ref so concurrent imports against the same local repo
  // can't race on `update-ref` between this run's update and bundle create.
  const tempRef = `refs/paperclip/ssh-sync/import/${randomUUID()}`;

  try {
    await runLocalGit(input.localDir, ["update-ref", tempRef, input.snapshot.headCommit], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    // Git bundles advertise only the requested refs. Import remote tracking
    // refs too, so publication hooks can select a baseline without a fetch.
    // Query Git instead of .git/refs: worktrees can share packed refs.
    const remoteRefsResult = await runLocalGit(input.localDir, [
      "for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes/",
    ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const remoteRefs = remoteRefsResult.stdout.trim().split("\n").filter(Boolean)
      .map((line) => {
        const [name, target] = line.split("\t");
        return { name: name!, target: target || null };
      });
    await runLocalGit(input.localDir, ["bundle", "create", bundlePath, tempRef, "--remotes"], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const originUrl = await readSanitizedOriginRemoteUrl(input.localDir);

    const remoteSetupScript = [
      "set -e",
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "import-XXXXXX.bundle"))})`,
      'trap \'rm -f "$tmp_bundle"\' EXIT',
      'cat > "$tmp_bundle"',
      `if [ ! -d ${shellQuote(path.posix.join(input.remoteDir, ".git"))} ]; then git init ${shellQuote(input.remoteDir)} >/dev/null; fi`,
      // Carry the workspace's (credential-scrubbed) origin into the transported
      // repo so branches there keep a publishable remote instead of reading as
      // remote-less snapshots. set-url covers a reused workspace whose origin
      // changed; add covers the fresh-init case. Best-effort under `set -e`.
      ...(originUrl
        ? [
          `{ git -C ${shellQuote(input.remoteDir)} remote set-url origin ${shellQuote(originUrl)} >/dev/null 2>&1 || git -C ${shellQuote(input.remoteDir)} remote add origin ${shellQuote(originUrl)} >/dev/null 2>&1; } || true`,
        ]
        : []),
      // Remove old symbolic destinations before the wildcard fetch. Fetching
      // through origin/HEAD could overwrite its previous target on reuse.
      `for ref in $(git -C ${shellQuote(input.remoteDir)} for-each-ref --format='%(refname)' refs/remotes/); do`,
      `  if git -C ${shellQuote(input.remoteDir)} symbolic-ref -q "$ref" >/dev/null; then`,
      `    git -C ${shellQuote(input.remoteDir)} symbolic-ref --delete "$ref"`,
      "  fi",
      "done",
      // Prune before fetching to permit topic <-> topic/child replacements.
      // Keep the wildcard even for an empty source to remove obsolete refs.
      `git -C ${shellQuote(input.remoteDir)} fetch --force --prune "$tmp_bundle" '${tempRef}:${tempRef}' '+refs/remotes/*:refs/remotes/*' >/dev/null`,
      // Bundles advertise symbolic refs as direct refs. Restore their targets.
      ...remoteRefs.filter((ref) => ref.target).map((ref) =>
        `git -C ${shellQuote(input.remoteDir)} symbolic-ref ${shellQuote(ref.name)} ${shellQuote(ref.target!)} >/dev/null`),
      input.snapshot.branchName
        ? `git -C ${shellQuote(input.remoteDir)} checkout --force -B ${shellQuote(input.snapshot.branchName)} ${shellQuote(input.snapshot.headCommit)} >/dev/null`
        : `git -C ${shellQuote(input.remoteDir)} -c advice.detachedHead=false checkout --force --detach ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} reset --hard ${shellQuote(input.snapshot.headCommit)} >/dev/null`,
      `git -C ${shellQuote(input.remoteDir)} clean -fdx -e .paperclip-runtime >/dev/null`,
      // Drop the per-import ref on the remote side too so it can't accumulate.
      `git -C ${shellQuote(input.remoteDir)} update-ref -d ${shellQuote(tempRef)} >/dev/null 2>&1 || true`,
    ].join("\n");

    // The git bundle is a real local file of known size, so report an exact
    // percentage. No `workspace` label: the "Importing git history" phase is
    // already self-describing in the log line.
    const progress = input.onProgress
      ? createTransferProgress({
        onProgress: input.onProgress,
        phase: "Importing git history",
        direction: "to",
        totalBytes: (await fs.stat(bundlePath)).size,
        estimated: false,
      })
      : null;

    try {
      await streamLocalFileToSsh({
        spec: input.spec,
        localFile: bundlePath,
        remoteScript: remoteSetupScript,
        progress: progress ?? undefined,
      });
      await progress?.finish();
    } catch (error) {
      await progress?.fail();
      throw error;
    }
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", tempRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function exportGitWorkspaceFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  importedRef?: string;
  resetLocalWorkspace?: boolean;
  onProgress?: RuntimeProgressSink;
}): Promise<string> {
  await runLocalGit(input.localDir, ["rev-parse", "--git-dir"]);
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bundle-"));
  const bundlePath = path.join(bundleDir, "workspace.bundle");
  const importedRef = input.importedRef ?? `refs/paperclip/ssh-sync/imported/${randomUUID()}`;

  try {
    const exportScript = [
      "set -e",
      `git -C ${shellQuote(input.remoteDir)} update-ref refs/paperclip/ssh-sync/export HEAD`,
      `mkdir -p ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime"))}`,
      `tmp_bundle=$(mktemp ${shellQuote(path.posix.join(input.remoteDir, ".paperclip-runtime", "export-XXXXXX.bundle"))})`,
      'cleanup() { rm -f "$tmp_bundle"; git -C ' + shellQuote(input.remoteDir) + ' update-ref -d refs/paperclip/ssh-sync/export >/dev/null 2>&1 || true; }',
      'trap cleanup EXIT',
      `git -C ${shellQuote(input.remoteDir)} bundle create "$tmp_bundle" refs/paperclip/ssh-sync/export >/dev/null`,
      'cat "$tmp_bundle"',
    ].join("\n");

    for (let attempt = 0; ; attempt += 1) {
      try {
        // The remote bundle size isn't known before streaming, so report bytes
        // received (MB mode) with a terminal completion line.
        const progress = input.onProgress
          ? createTransferProgress({
            onProgress: input.onProgress,
            phase: "Exporting git history",
            direction: "from",
            totalBytes: null,
            estimated: false,
          })
          : null;

        try {
          await streamSshToLocalFile({
            spec: input.spec,
            remoteScript: exportScript,
            localFile: bundlePath,
            progress: progress ?? undefined,
          });
          await progress?.finish();
        } catch (error) {
          await progress?.fail();
          throw error;
        }

        await runLocalGit(input.localDir, ["fetch", "--force", bundlePath, `refs/paperclip/ssh-sync/export:${importedRef}`], {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        });
        break;
      } catch (error) {
        const failure = error as { message?: string; stderr?: string };
        const detail = `${failure.message ?? ""}\n${failure.stderr ?? ""}`;
        if (attempt !== 0 || !/early EOF|index-pack/i.test(detail)) throw error;
      }
    }
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["reset", "--hard", importedRef], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    }
    const importedHead = await runLocalGit(input.localDir, ["rev-parse", importedRef], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    return importedHead.stdout.trim();
  } finally {
    if (input.resetLocalWorkspace !== false) {
      await runLocalGit(input.localDir, ["update-ref", "-d", importedRef], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      }).catch(() => undefined);
    }
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function integrateImportedGitHead(input: {
  localDir: string;
  importedHead: string;
}): Promise<void> {
  const isConcurrentRefUpdateError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("cannot lock ref") && message.includes("expected");
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readLocalGitWorkspaceSnapshot(input.localDir);
    if (!snapshot) throw new Error("The local workspace has no Git checkout.");

    const currentHead = snapshot.headCommit;
    if (!currentHead || currentHead === input.importedHead) return;

    const headRef = snapshot.branchName ? `refs/heads/${snapshot.branchName}` : "HEAD";
    // `git merge-base` exits 1 when the commits share no ancestor — the only
    // outcome that authorizes the graft fallback below. Every other failure
    // (timeout, missing object, repository error) must keep failing the
    // integration instead of silently rewriting the tip.
    let noCommonAncestor = false;
    const mergeBase = await runLocalGit(input.localDir, ["merge-base", currentHead, input.importedHead], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    }).catch((error: unknown) => {
      noCommonAncestor = (error as { code?: unknown } | null)?.code === 1;
      return null;
    });
    const mergeBaseHead = mergeBase?.stdout.trim() ?? "";

    if (mergeBaseHead === input.importedHead) {
      return;
    }

    if (mergeBaseHead === currentHead) {
      try {
        await updateGitHeadAndIndex(input.localDir, headRef, currentHead, input.importedHead);
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    if (noCommonAncestor) {
      // No common ancestor — merging is impossible and failing here would
      // discard the imported work. Graft it onto the current head instead;
      // see createUnrelatedHistoryGraftCommit.
      const graftCommit = await createUnrelatedHistoryGraftCommit({
        localDir: input.localDir,
        currentHead,
        importedHead: input.importedHead,
        syncLabel: "Paperclip SSH sync",
      });
      try {
        await updateGitHeadAndIndex(input.localDir, headRef, currentHead, graftCommit);
        return;
      } catch (error) {
        if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
        throw error;
      }
    }

    let mergedTree;
    try {
      mergedTree = await runLocalGit(input.localDir, ["merge-tree", "--write-tree", currentHead, input.importedHead], {
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to merge concurrent SSH git histories for ${currentHead.slice(0, 12)} and ${input.importedHead.slice(0, 12)}: ${reason}`,
      );
    }
    const mergedTreeId = mergedTree.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (!mergedTreeId) {
      throw new Error("Failed to compute a merged git tree for SSH workspace restore.");
    }

    const mergeCommit = await runLocalGit(
      input.localDir,
      [
        ...GIT_SYNC_COMMIT_IDENTITY_ARGS,
        "commit-tree",
        mergedTreeId,
        "-p",
        currentHead,
        "-p",
        input.importedHead,
        "-m",
        `Paperclip SSH sync merge ${input.importedHead.slice(0, 12)}`,
      ],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      },
    );
    try {
      await updateGitHeadAndIndex(input.localDir, headRef, currentHead, mergeCommit.stdout.trim());
      return;
    } catch (error) {
      if (isConcurrentRefUpdateError(error) && attempt < 4) continue;
      throw error;
    }
  }

  throw new Error(`Failed to integrate concurrent SSH git history for ${input.importedHead.slice(0, 12)} after multiple retries.`);
}

export const PROJECT_REPOSITORY_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

async function isLocalGitRepositoryRoot(localDir: string): Promise<boolean> {
  try {
    const toplevel = await runLocalGit(localDir, ["rev-parse", "--show-toplevel"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const [directory, repository] = await Promise.all([
      fs.realpath(localDir),
      fs.realpath(toplevel.stdout.trim()),
    ]);
    return directory === repository;
  } catch {
    return false;
  }
}

export async function listLocalProjectRepositories(localDir: string): Promise<string[]> {
  const root = path.join(localDir, PROJECT_REPOSITORIES_DIR);
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Invalid project repositories directory");
  }
  const repositories: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROJECT_REPOSITORY_NAME_PATTERN.test(entry.name)) {
      throw new Error("Invalid project repository directory");
    }
    const relative = `${PROJECT_REPOSITORIES_DIR}/${entry.name}`;
    if (!(await isLocalGitRepositoryRoot(path.join(localDir, relative)))) {
      throw new Error(`Project repository is not a Git checkout: ${relative}`);
    }
    repositories.push(relative);
  }
  return repositories.sort();
}

export async function transportGitWorkspaceToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  snapshot: LocalGitWorkspaceSnapshot;
  exclude?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel: string;
}): Promise<void> {
  await timeWorkspaceStep(input.onProgress, "Git import", () => importGitWorkspaceToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    snapshot: input.snapshot,
    onProgress: input.onProgress,
  }));
  await timeWorkspaceStep(input.onProgress, "Workspace sync", () => syncDirectoryToSsh({
    spec: input.spec,
    localDir: input.localDir,
    remoteDir: input.remoteDir,
    exclude: [".git", ".paperclip-runtime", ...SSH_WORKSPACE_EXCLUDES, ...(input.exclude ?? [])],
    excludeTaggedCaches: true,
    onProgress: input.onProgress,
    progressLabel: input.progressLabel,
  }));
  await removeDeletedPathsOnSsh({
    spec: input.spec,
    remoteDir: input.remoteDir,
    deletedPaths: input.snapshot.deletedPaths,
  });
}

export async function excludeProjectRepositoriesOnSsh(spec: SshConnectionConfig, remoteDir: string): Promise<void> {
  const pattern = `/${PROJECT_REPOSITORIES_DIR}/`;
  const excludeFile = path.posix.join(remoteDir, ".git", "info", "exclude");
  await runSshScript(
    spec,
    `mkdir -p ${shellQuote(path.posix.dirname(excludeFile))} && ` +
      `{ grep -qxF ${shellQuote(pattern)} ${shellQuote(excludeFile)} 2>/dev/null || ` +
      `printf '\\n%s\\n' ${shellQuote(pattern)} >> ${shellQuote(excludeFile)}; }`,
    { timeoutMs: 30_000 },
  );
}
