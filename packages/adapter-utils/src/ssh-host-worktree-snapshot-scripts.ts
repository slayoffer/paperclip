import { shellQuote } from "./ssh-config.js";
import { HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS } from "./ssh-host-worktree-constants.js";

// Git keeps refs/worktree references private to each linked worktree.
export const HOST_WORKTREE_INCOMING_WIP_REF = "refs/worktree/paperclip/incoming-wip";

/** Build a temporary index without changing the real index or branch. */
export function buildHostWipIndexScript(worktreePath: string): string[] {
  const wt = shellQuote(worktreePath);
  const excludes = HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS.map(shellQuote).join(" ");
  return [
    'snapshot_dir=$(mktemp -d)',
    'trap \'rm -rf "$snapshot_dir"\' EXIT',
    'idx="$snapshot_dir/index"',
    'sizes="$snapshot_dir/sizes"',
    'paths="$snapshot_dir/paths"',
    'staged="$snapshot_dir/staged"',
    `head=$(git -C ${wt} rev-parse --verify HEAD)`,
    // The imported snapshot can contain ignored files absent from the real index.
    // Reuse only its permitted paths. Git add below reads their current content.
    `incoming=$(git -C ${wt} rev-parse --verify ${shellQuote(HOST_WORKTREE_INCOMING_WIP_REF)} 2>/dev/null || true)`,
    'if [ -n "$incoming" ]; then',
    `  GIT_INDEX_FILE="$idx" git -C ${wt} read-tree "$incoming"`,
    `  GIT_INDEX_FILE="$idx" git -C ${wt} ls-files --stage -z -- . ${excludes} > "$staged"`,
    `  GIT_INDEX_FILE="$idx" git -C ${wt} read-tree "$head"`,
    `  GIT_INDEX_FILE="$idx" git -C ${wt} update-index -z --index-info < "$staged"`,
    'else',
    `  GIT_INDEX_FILE="$idx" git -C ${wt} read-tree "$head"`,
    'fi',
    `git -C ${wt} ls-files --stage -z -- . ${excludes} > "$staged"`,
    `GIT_INDEX_FILE="$idx" git -C ${wt} update-index -z --index-info < "$staged"`,
    `GIT_INDEX_FILE="$idx" git -C ${wt} ls-files -z --cached --others --exclude-standard -- . ${excludes} > "$paths"`,
    `GIT_INDEX_FILE="$idx" git -C ${wt} --literal-pathspecs add -A -f --pathspec-from-file="$paths" --pathspec-file-nul`,
    `tree=$(GIT_INDEX_FILE="$idx" git -C ${wt} write-tree)`,
    `head_tree=$(git -C ${wt} rev-parse "$head^{tree}")`,
  ];
}

/** Include imported ignored paths in each safety check. */
export function buildHostDirtyCheckScript(worktreePath: string): string[] {
  const wt = shellQuote(worktreePath);
  return [
    ...buildHostWipIndexScript(worktreePath),
    `if [ "$tree" != "$head_tree" ] || [ -n "$(GIT_OPTIONAL_LOCKS=0 git -C ${wt} status --porcelain=v1 --untracked-files=normal)" ]; then dirty=1; else dirty=0; fi`,
  ];
}
