import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

/** A successful rev-parse alone can identify a parent checkout. Check ownership. */
export function sshInPlaceGitProbeScript(worktreePath: string): string {
  return [
    `workspace=${shellQuote(worktreePath)}`,
    'root=$(cd "$workspace" && pwd -P) || { echo host_git_unusable; exit 0; }',
    'unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE',
    'top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || top=',
    'if [ -z "$top" ]; then',
    // Plain directories remain supported, but managed worktree paths need Git.
    '  case "$root" in */.paperclip/worktrees/*) echo host_git_unusable; exit 0;; esac',
    `  if [ -e ${shellQuote(path.posix.join(worktreePath, ".git"))} ] || [ -L "$root/.git" ]; then echo host_git_unusable; exit 0; fi`,
    'else',
    '  top=$(cd "$top" && pwd -P) || { echo host_git_unusable; exit 0; }',
    '  if [ "$top" != "$root" ] || [ -L "$root/.git" ]; then echo host_git_unusable; exit 0; fi',
    '  admin=$(git -C "$root" rev-parse --absolute-git-dir) || { echo host_git_unusable; exit 0; }',
    '  admin=$(cd "$admin" && pwd -P) || { echo host_git_unusable; exit 0; }',
    '  common=$(git -C "$root" rev-parse --git-common-dir) || { echo host_git_unusable; exit 0; }',
    '  common=$(cd "$root" && cd "$common" && pwd -P) || { echo host_git_unusable; exit 0; }',
    '  if [ -f "$root/.git" ]; then',
    '    backlink=$(cat "$admin/gitdir") || { echo host_git_unusable; exit 0; }',
    '    if [ "$(dirname "$admin")" != "$common/worktrees" ] || [ "$backlink" != "$root/.git" ]; then echo host_git_unusable; exit 0; fi',
    '  elif [ -d "$root/.git" ] && [ "$admin" = "$root/.git" ]; then',
    '    case "$root" in */.paperclip/worktrees/*) echo host_git_unusable; exit 0;; esac',
    '  else echo host_git_unusable; exit 0',
    '  fi',
    'fi',
  ].join("\n");
}
