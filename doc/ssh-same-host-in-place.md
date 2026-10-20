# SSH same-host in_place execution

Status: available behind a flag, off by default (SYNA-2284, part of SYNA-2273).

## What it does

Without the flag, every SSH run copies the issue workspace to the host
(`<remoteCwd>/.paperclip-runtime/runs/<runId>/workspace`: a full git bundle plus a
tar of the tree). At run end, the server restores the changes into its worktree
under the 30 s merge lock.

When the Paperclip server and the SSH host share one disk, and the server's
worktree path is the same absolute path on the host, the run can work directly in
the server's worktree. With the flag on, the SSH driver returns an `in_place`
realization:

- The run cwd (and the SSH spawn cwd) is the server worktree path.
- No git bundle, no tar, no baseline snapshot, no restore merge.
- The project `provisionCommand` runs on the host in the worktree.
- Adapter runtime assets (skills, MCP config, Claude config, `CODEX_HOME`) go to a
  per-run folder outside the worktree:
  `<remoteCwd>/.paperclip-runtime/runs/<runId>/<adapter>`. The adapter removes
  this folder at run end. (`remoteCwd` is the environment's resolved
  `remoteWorkspacePath`.)
- `workspace_finalize` is recorded at run end with a terminal status on success
  and on failure, the same as in the copy mode. So `workspace_sync_pending`
  clears and cards do not wait.

Only `codex_local` and `claude_local` (CLI engine) honor `in_place`. Every other
adapter type keeps the copy mode. ACP engines do not support SSH targets.

## Turn it on

Set a server env allowlist of SSH environment ids, comma-separated:

```sh
PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS=<environment id>[,<environment id>...]
```

Optional: `PAPERCLIP_SSH_IN_PLACE_LOCK_WAIT_MS` (default `30000`), the time a run
waits for the worktree lock (see below) before it uses the copy mode.

The server reads both values for each run, so the value in the server process
environment applies to the next run.

## Host requirements

The flag is safe to set only when ALL of these are true:

1. The server's execution workspace paths resolve on the SSH host to the SAME
   folders (for example the same bind mount at the same absolute path, such as
   `/paperclip/...` in the container and on the host).
2. The SSH user can read and write those folders, and the server can read and
   write files that the SSH user creates there (same uid, or a shared group with
   a group-writable umask).
3. For a git worktree, the git admin folder that the worktree's `.git` file points
   to is also visible at the same path on the host, and `git` is installed there.
4. The environment's `remoteWorkspacePath` is NOT inside a worktree.

## Checks at run start

The SSH driver checks each run. A check failure never fails the run: the run uses
the copy mode, and the server logs one warning with the reason
("SSH same-host in_place is enabled for this environment, but this run uses the
copy mode").

- Path proof: the server writes a probe file with a random token into the
  worktree, then reads it over SSH at the same path. The run uses `in_place` only
  if the host reads the same token, the folder is writable for the SSH user, and
  `git rev-parse` works there (for a git workspace). The server removes the probe
  file at once. Reasons: `local_missing`, `host_missing`, `host_not_writable`,
  `host_path_mismatch`, `host_git_unusable`, `probe_failed`.
- Worktree lock: two runs must not work in one worktree at the same time (a child
  issue can reuse its parent's execution workspace). The lock is in the server
  process, keyed by the real path of the worktree, and held for the life of the
  run's environment lease. A second run waits up to the lock wait, then uses the
  copy mode (reason `worktree_busy:<runId>`). A holder whose lease is no longer
  `active` is stale, and the next run takes the lock. A server restart clears all
  locks (it also ends all runs).

## Rollback

Remove the environment id from `PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS` (or unset the
variable). The next run uses the copy mode. No data migration is necessary: the
server worktree was the run's workspace the whole time.

## Known limits

- A run in `in_place` mode and a copy-mode run of a different environment can
  still work on one worktree at the same time. The copy run's restore merge then
  sees the in_place run's edits as local changes.
- Per-run folders of copy-mode runs (`.paperclip-runtime/runs/<runId>/workspace`)
  are not removed by this change.

Code: `server/src/services/ssh-in-place-workspace.ts` (flag, probe, lock),
the SSH driver in `server/src/services/environment-runtime.ts`, and
`resolveAdapterExecutionTargetInPlaceRuntimeRootDir` in
`packages/adapter-utils/src/execution-target.ts`.
