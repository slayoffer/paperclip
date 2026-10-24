# Workspace operations

## Child execution contexts

A child inherits its parent’s project and project workspace by default.
It does not inherit the parent’s execution workspace binding.
The child realizes its own branch from its selected base ref.
The child helper preserves unresolved strategy settings, but removes the parent’s exact branch pin.
An explicit child branch or base ref takes precedence.

Set `inheritExecutionWorkspaceFromIssueId` to request a source execution workspace.
The internal child helper also supports explicit `executionWorkspaceInheritanceMode: "linkage"`.
A direct execution workspace binding remains supported.
A requested branch that differs from the saved workspace branch requires a separate realization.

Before cross-issue reuse, the runtime checks staged, unstaged, and untracked Git changes.
A dirty workspace or failed status check prevents restoration of that workspace.
For `reuse_existing`, dispatch selects a separate issue workspace before it applies inherited configuration.
It saves the reason in the new workspace metadata and the run warnings.
The issue saves its selected strategy. Later wakes use the same binding and strategy.
They can resume that issue's own changes and provider session.
An explicit branch request or suspended execution keeps its exact workspace and fails closed.
The runtime does not repair or provision that workspace for the other issue.
The source issue can resume its own dirty workspace.
The check covers persisted bindings and registered worktrees selected by branch.
Owner selection compares canonical paths within the company, including saved and candidate symbolic-link paths.
Company and project access checks still apply.

## Task environment selection

`executionWorkspaceSettings.environmentId` selects an environment for one task.
The task selection precedes the agent, instance, and local defaults.
A null or absent selection uses the existing default order.
Create and update preserve the selection when isolated workspaces are disabled.
This setting does not enable isolated workspace controls.
The server validates the identifier, environment availability, driver, and provider restrictions before workspace changes.
Instance sandbox requirements still apply.

When a task selects a different environment, the runtime creates a separate execution workspace binding.
It preserves the inherited binding and records it in `derivedFromExecutionWorkspaceId`.
The task binding borrows the source checkout. Its cleanup does not remove the source files or branch.
Parent and sibling tasks retain their bindings and environment defaults.
A suspended native execution cannot change its admitted environment. Start a new execution after such a change.

The release workflow runs the policy, heartbeat default, and task routing regression suites.

## Workspace transport

For sandbox file synchronization, lock ownership, and the required upgrade
procedure from directory locks, see [Workspace restore locks](workspace-restore-locks.md).

SSH workspace preparation and restore share two operation slots per server process.
The queue includes workspace transfers, baseline capture, and runtime assets.
Directory scans, file content reads, SHA-256 hashes, and SQLite manifest writes run in worker threads.
Each worker reads file contents with a fixed-size buffer.
Memory snapshots transfer metadata in small batches with acknowledgements.
Disk snapshots return a manifest descriptor after the worker closes the database.
Snapshot formats and restore merge rules stay the same.

Run logs show queue wait times and elapsed times for Git import, workspace sync,
baseline capture, and asset sync. Each step reports its start and its result.
The queue does not change the agent run cap or execution leases.

SSH transfer stream errors fail only the affected transfer. The transfer closes its streams and stops its child processes.
It waits for child closure before cleanup. After five seconds, it sends `SIGKILL` to children that remain.
The caller receives the error, and progress logs record a failure when progress reporting is enabled.

SSH Git imports preserve the source repository's remote tracking references.
The bundle includes their history and restores symbolic references such as `origin/HEAD`.
Repeated imports prune obsolete remote references before they import replacements, including replacements with conflicting reference names.
This includes packed references from linked worktrees.
Publication hooks can use these references to select the candidate commit range.
The import does not contact the upstream repository or create a baseline that the source lacks.

The persistent host-worktree primitives remain separate from the active SSH execution path.
They fetch only references that a delta bundle advertises, then check objects before updating the remaining references.
Exports include a manifest of branches, tags, and remote-tracking references.
The default import namespace includes the repository key, worktree name, and run identifier.
Snapshot indexes start from `HEAD` and include only permitted files. The real index stays unchanged.
Snapshots include permitted files that the user explicitly stages, including new ignored files.
Unstaged ignored files and excluded runtime paths remain outside the snapshot.

Host exports fetch into a unique temporary reference namespace before replacing the imported manifest.
The importer preserves the previous and desired objects under `refs/paperclip/host-import/<id>/` during replacement.
It removes obsolete references before installing conflicting ancestor or descendant names, including packed references.
Successful imports remove these temporary references. Failed imports retain them for recovery.

Host lock creation and ownership-checked removal share a short directory guard.
Each operation removes its guard when it exits normally or receives a handled signal.
An unhandled process termination can leave the guard present. Later operations fail closed after ten seconds.
An operator must check the host processes before removing such a guard.
