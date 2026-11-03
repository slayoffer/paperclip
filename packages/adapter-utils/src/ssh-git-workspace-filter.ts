import { shouldExcludePath } from "./exclude-patterns.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { shellQuote, type SshRemoteExecutionSpec } from "./ssh-config.js";
import { runLocalGit, runSshCommand } from "./ssh-command.js";
import { clearRemoteDirectory, removeDeletedPathsOnSsh } from "./ssh-sync.js";

export async function filterGitWorkspaceOnSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  headCommit: string;
  skippedPaths: string[];
}): Promise<void> {
  const skipped = new Set(input.skippedPaths);
  if (!skipped.has(".")) {
    const tracked = await runLocalGit(input.localDir,
      ["ls-tree", "-r", "--name-only", "-z", input.headCommit],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    for (const relative of tracked.stdout.split("\0").filter(Boolean)) {
      const parts = relative.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const ancestor = parts.slice(0, count).join("/");
        if (shouldExcludePath(ancestor, SSH_WORKSPACE_EXCLUDES)) {
          skipped.add(ancestor);
          break;
        }
      }
    }
  }
  const skippedPaths = [...skipped];
  if (skippedPaths.length === 0) return;
  // Missing excluded files must not become deletions in the agent's next commit.
  await runSshCommand(input.spec, "sh -s", { stdin: [
    "set -e",
    `cd ${shellQuote(input.remoteDir)}`,
    'skip_index=$(mktemp)',
    'trap \'rm -f "$skip_index"\' EXIT',
    `git --literal-pathspecs ls-files -z -- ${skippedPaths.map(shellQuote).join(" ")} > "$skip_index"`,
    'git update-index --skip-worktree -z --stdin < "$skip_index"',
  ].join("\n"), timeoutMs: 30_000, maxBuffer: 256 * 1024 });
  if (skippedPaths.includes(".")) {
    await clearRemoteDirectory({ spec: input.spec, remoteDir: input.remoteDir,
      preserveEntries: [".git", ".paperclip-runtime"] });
  } else {
    await removeDeletedPathsOnSsh({ spec: input.spec, remoteDir: input.remoteDir, deletedPaths: skippedPaths });
  }
}
