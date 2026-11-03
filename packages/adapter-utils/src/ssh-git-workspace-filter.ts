import { shellQuote, type SshRemoteExecutionSpec } from "./ssh-config.js";
import { runSshCommand } from "./ssh-command.js";
import { clearRemoteDirectory, removeDeletedPathsOnSsh } from "./ssh-sync.js";

export async function filterGitWorkspaceOnSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  skippedPaths: string[];
}): Promise<void> {
  if (input.skippedPaths.length === 0) return;
  // Missing excluded files must not become deletions in the agent's next commit.
  await runSshCommand(input.spec, "sh -s", { stdin: [
    "set -e",
    `cd ${shellQuote(input.remoteDir)}`,
    'skip_index=$(mktemp)',
    'trap \'rm -f "$skip_index"\' EXIT',
    `git --literal-pathspecs ls-files -z -- ${input.skippedPaths.map(shellQuote).join(" ")} > "$skip_index"`,
    'git update-index --skip-worktree -z --stdin < "$skip_index"',
  ].join("\n"), timeoutMs: 30_000, maxBuffer: 256 * 1024 });
  if (input.skippedPaths.includes(".")) {
    await clearRemoteDirectory({ spec: input.spec, remoteDir: input.remoteDir,
      preserveEntries: [".git", ".paperclip-runtime"] });
  } else {
    await removeDeletedPathsOnSsh({ spec: input.spec, remoteDir: input.remoteDir, deletedPaths: input.skippedPaths });
  }
}
