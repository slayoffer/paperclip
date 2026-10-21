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
  Git reports that exact folder as its repository root. A linked worktree must use
  its own administration directory under the common repository's `worktrees` folder.
  The administration directory must point back to that worktree's `.git` file.
  A missing `.git` file cannot pass through discovery of a parent repository.
  Managed worktree paths cannot use the plain-directory exception.
  The server removes the probe file at once. Reasons: `local_missing`, `host_missing`, `host_not_writable`,
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
  On supported Linux hosts, each provider invocation starts in a unique systemd scope.
  The scope uses the static description `Paperclip SSH writer`.
  Its unit name contains only a random invocation identifier.
  These properties keep provider arguments and environment values out of systemd journal descriptions.
  The scope uses a control group in version 2 of the Linux control group filesystem.
  Descendants remain in that group when they create new sessions or process groups.
  The launcher records the remote PID, control group, and kernel boot identity before provider execution.
  These records remain under `<remoteWorkspacePath>/.paperclip-runtime/ssh-writers/<runId>`.
  They remain outside adapter runtime cleanup.
  At release, the driver checks all recorded groups through SSH on the original endpoint.
  A populated group prevents release, including when only detached descendants remain.
  An empty group, a removed verified scope, or a different kernel boot proves termination.
  The driver saves the receipt before it removes ownership.
  At the next run startup, acquisition repeats this check for a terminal owner run.
  Server startup and periodic execution reconciliation also check terminal owners.
  Each sweep scans at most twenty leases and advances through older uncertain rows.
  It validates company, run, lease, worktree, and original SSH endpoint identities.
  Legacy leases can recover their worktree path from the execution workspace.
  A recorded remote PID must be absent. A surviving PID or an uncertain check preserves ownership.
  Existing containment records without a PID still require verified empty control groups.
  These checks use the same SSH path. Permission errors preserve ownership.
  The local SSH client PID cannot prove remote termination.
  A saved receipt permits ownership release after a server interruption.
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
- Receipts require Linux control groups version 2 and a reachable systemd user manager.
  The `systemd-run` command must support `--expand-environment=no` (systemd 254 or newer).
  Without these capabilities, commands run without containment and ownership remains.
  A scope creation failure fails the command and preserves ownership.
- Earlier session-only records cannot prove termination. Their ownership remains.
- The scope contains ordinary descendants, including detached children.
  This mechanism does not isolate hostile processes with permission to move into another control group.
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

## Missing Git metadata

Workspace preparation checks Git ownership before branch repair. The check rejects
parent discovery, foreign administration directories, and symbolic links at `.git`.

When the administration directory remains, preparation restores its missing `.git`
link. The backlink and common directory must identify the exact worktree.
This repair preserves working files, staged changes, and the branch tip.

When administration data is absent, preparation can reconstruct a runtime-owned
branch under `.paperclip/worktrees`. It first moves the full old folder into
`.paperclip/worktree-quarantine`. It then attaches the recorded branch at its
existing tip. The warning and workspace operation record name the preserved folder.
It does not create a missing branch or detach a branch from another worktree.
An unsafe repair reports a structured workspace validation failure. The existing
board recovery flow handles that failure instead of an unclassified setup error.

A failed `git worktree remove --force` can leave this condition. Git can delete
both `.git` and its administration directory before a protected file prevents
folder removal. Cleanup preserves the branch when removal fails. This permits
later reconstruction. Folder contents alone do not prove that a worktree remains.
Inspect failed `worktree_cleanup` operations for permission errors before assigning
this cause to a specific incident.
