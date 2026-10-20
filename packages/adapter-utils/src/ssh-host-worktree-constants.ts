export const HOST_WORKTREE_ROOT_DIR = ".paperclip-host";
export const HOST_WORKTREE_MARKER_ERROR = "PAPERCLIP_HOST_ERROR";
export const HOST_WORKTREE_MARKER_LOCK = "PAPERCLIP_HOST_LOCK";
export const HOST_WORKTREE_MARKER_MATERIALIZE = "PAPERCLIP_HOST_MATERIALIZE";
export const HOST_WORKTREE_MARKER_EXPORT = "PAPERCLIP_HOST_EXPORT";
export const HOST_WORKTREE_MARKER_INSPECT = "PAPERCLIP_HOST_INSPECT";
export const HOST_WORKTREE_MARKER_REMOVE = "PAPERCLIP_HOST_REMOVE";
export const HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES = 50 * 1024 * 1024;

/** WIP snapshots never include dependency folders or nested agent clones. */
export const HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS = [
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob).worktrees",
  ":(exclude,glob).worktrees/**",
  ":(exclude,glob).paperclip-runtime",
  ":(exclude,glob).paperclip-runtime/**",
] as const;
