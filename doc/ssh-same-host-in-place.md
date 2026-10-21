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
  `remoteWorkspacePath`.) Provider transcripts persist outside this folder.
  Their path is `.paperclip-runtime/provider-sessions/<companyId>/<workspaceHash>/<adapter>`.
  Codex links `home/sessions` and `home/archived_sessions` to that path.
  Managed Claude links `config-seed/projects` to that path.
  Credentials and configuration stay in temporary runtime assets.
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
- Runtime isolation: the host resolves existing ancestors before the containment check.
  This check detects symlinks in the remote base and runtime paths.
  Runtime assets and provider sessions must stay outside repository trees.
  A failed path check selects copy mode before any runtime upload.
- Worktree lock: a durable file records the lease and controller identity.
  The file sits in `.paperclip-in-place-locks` beside the canonical worktree.
  An exclusive directory guard serializes ownership changes across server processes.
  A second run waits for the configured interval, then selects copy mode.
  A server restart preserves the file.
  A lease timeout or a dead controller does not prove remote writer termination.
  Stale ownership transfers require an inactive lease and a bound provider termination receipt.
  Missing termination evidence keeps the lock, including after normal lease release.
  SSH client exit, run success, failure, cancellation, and timeout do not prove writer termination.
  On Linux, each SSH provider invocation starts in a dedicated session through `setsid`.
  The launcher records its session ID and kernel boot ID before it executes the provider.
  These records remain under `<remoteWorkspacePath>/.paperclip-runtime/ssh-writers/<runId>`.
  They remain outside adapter runtime cleanup.
  At release, the driver checks all recorded sessions through SSH on the original endpoint.
  A child in any recorded session prevents release, even after its parent exits.
  A complete process scan with no remaining session produces a bound provider termination receipt.
  The driver saves the receipt before it removes ownership.
  At the next run startup, acquisition repeats this check for a terminal owner run.
  This also recovers an active bookkeeping lease after a controller interruption.
  Missing records, unsupported hosts, failed checks, and changed endpoints preserve ownership.
  Do not remove ownership files based only on a run status or elapsed time.
  An interrupted directory guard also stays closed. The server never removes it through a timeout.

## Rollback

Remove the environment id from `PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS` (or unset the
variable). The next run uses the copy mode. No data migration is necessary: the
server worktree was the run's workspace the whole time.

## Known limits

- A run in `in_place` mode and a copy-mode run of a different environment can
  still work on one worktree at the same time. The copy run's restore merge then
  sees the in_place run's edits as local changes.
- Older runs have no writer records. Their ownership remains until an operator proves termination.
  Manual recovery requires separate authorization. This change does not remove old locks by age.
- The receipt covers the recorded Linux sessions. A provider must not detach a writer into a separate session.
- Non-Linux hosts and hosts without `setsid` cannot supply these receipts.
- Writer identity records persist for recovery. They contain no credentials or command arguments.
- Production acceptance requires homelab to compare consecutive realizations and restore-lock timeout counts after deployment.
- Provider transcripts remain on the SSH host until an operator removes them.
  Per-run cleanup does not delete transcripts.
- Per-run folders of copy-mode runs (`.paperclip-runtime/runs/<runId>/workspace`)
  are not removed by this change.

Code: `server/src/services/ssh-in-place-workspace.ts` (flag, probe, lock),
the SSH driver in `server/src/services/environment-runtime.ts`, and
`resolveAdapterExecutionTargetInPlaceRuntimeRootDir` in
`packages/adapter-utils/src/execution-target.ts`.
