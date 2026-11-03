# SSH workspace synchronization

SSH workspace transfers exclude generated directories at every depth:

- `node_modules`
- `dist`, `build`, and `out`
- `coverage`
- `.next`, `.turbo`, and `.cache`

The baseline snapshot uses the same exclusions as the transfer.
Sync-back preserves these local directories, including their contents.
This rule also applies when the workspace uses `workspaceFileMode: "all"`.
A remote file or symbolic link cannot replace a directory with excluded local descendants.
The restore rejects that replacement before it changes local files or integrates Git history.
Direct Git restoration without a supplied baseline uses the same staged merge.
It captures a filtered local baseline and imports history only after the safety check.
History integration also prepares the index with a two-tree merge before it advances HEAD.
The Git index lock protects this change. The index update does not change working files.
Nonconflicting local staged changes remain staged. Conflicting staged changes reject before HEAD advances.
Dirty remote edits remain unstaged above the imported commit.
Runtime assets retain their separate transfer settings.

## Rebuildable caches

Workspace file transfers use one shared exclusion list in both directions.
The cache names are `node_modules`, `.pnpm-store`, `.turbo`, `.next`, `.cache`,
`__pycache__`, and `.venv`. These names match at every directory depth.
The existing `dist`, `build`, `out`, `coverage`, Git metadata, and runtime
exclusions remain in place.

A directory that contains a `CACHEDIR.TAG` file is also excluded, regardless
of its name or Git ignore rules. File presence is sufficient. The tag content
does not need a specific signature. A directory named `CACHEDIR.TAG` is not
a marker. Cargo's tagged `target/` directory is excluded. An untagged
directory named `target` is transferred. Tag paths are literal and relative
to the workspace, so a tag does not exclude an unrelated directory with the
same name. Discovery filters records with the same root-relative exclusion
matcher and literal ignored-path matcher as baseline capture and restore.
For example, `workspaceExclude: ["cache"]` excludes the root `cache` directory.
A tag in `nested/cache` still enters the baseline's protected paths.

The scan prunes caller exclusions before it reads directory contents. It uses
the shared matcher's scopes for `workspaceExclude`, referenced-project `vendor`,
and fixed cache names, plus literal resolved Git ignore paths. A POSIX shell
walk uses built-in commands, without a separate process for each directory.
The script and quoted exclusions travel through stdin on both sides; they
never expand command-line arguments. It reports tags and unreadable directories
as NUL-delimited records, which TypeScript checks with the same matchers.
An excluded unreadable directory does not abort sync. An unreadable directory
outside those exclusions does. Other scan failures still stop sync.

These rules cover Git-backed workspaces, linked Git worktrees, plain folders,
and `workspaceFileMode: "all"`. Referenced projects use the same list during
upload, plus their existing `vendor`, Git metadata, and resolved ignore rules.
Referenced projects remain read-only inputs and have no restore path.
Runtime assets retain their existing transfer settings. Git bundles retain
repository history. These rules do not remove objects already committed to Git.
After Git checkout, preparation removes tagged caches and fixed generated-directory paths from the remote working tree.
Their index entries use `skip-worktree`, so ordinary staging does not commit their removal.
A tagged root retains only Git metadata and managed runtime files.
Upload size estimation returns zero for a whole-root exclusion without scanning its contents.

Restore preserves excluded local directories and their contents. It combines
the tags captured before execution with tags present locally or remotely at
restore time. Removing a remote tag does not expose a protected local cache.
A remote tag also prevents deletion of the corresponding local directory.
Replacing a parent that contains an excluded local directory fails before
local changes or Git history integration.
For a tagged workspace root, the baseline records the whole-root `.` exclusion.
Restore skips that workspace before any scan, transfer, or history integration.
This state survives baseline serialization and removal of the local marker.
Serialized in-memory baselines also retain literal paths for nested tagged caches.
Restore also checks current root markers before it restores nested project repositories.
A marker added after preparation protects the root and its nested repositories.
Preparation also skips separate nested repository uploads when the workspace root is tagged.
The same protection applies to a tagged `.paperclip-repositories` container.
Clone and scratch discovery prunes tagged caches before reading their children.
Cache discovery then prunes the discovered clone and scratch paths.
Both policies retain saved literal exclusions during baseline capture and restore.
Each scan also prunes paths that an earlier scan recorded in the same policy.
Policy discovery scripts also travel through stdin, so large saved exclusion lists remain valid.
Remote text output retains UTF-8 characters split across transport chunks.
The restore archive command travels through stdin. Large cache exclusion lists
do not become one SSH command-line argument.

The tests in `packages/adapter-utils/src/ssh-cache-excludes.test.ts` run real
Git and tar through a local SSH substitute. On base `b411be160`, ignored
`node_modules` and `.cache` stayed out in both directions. An untracked,
tagged `target/` transferred in both directions. The same prepare results
applied to referenced projects. The homelab note that only
`.paperclip-runtime` was excluded does not describe this base.

## Nested repositories and scratch directories

Before each workspace transfer, Paperclip excludes nested directories with a `.git` entry.
The entry can be a directory, a file, or a symbolic link.
The workspace root remains eligible for transfer.
Explicit project repositories still transfer as separate workspace roots.
Their nested repositories follow the same exclusion rule.

Scratch directory names also match `.scratch-*` and `.cto-*` by default, at every depth.
Set `PAPERCLIP_SSH_SCRATCH_PATTERNS` on the Paperclip server to replace these defaults:

```sh
PAPERCLIP_SSH_SCRATCH_PATTERNS='[".scratch-*", ".cto-*", "temp-*"]'
```

The value must be a JSON array of nonempty directory name patterns, without `/` or NUL characters.
Patterns use shell glob syntax, including `*`, `?`, and character classes.
An empty array disables scratch name exclusions. Nested repository exclusion stays active.
Invalid configuration stops workspace preparation before remote changes.
The selected patterns remain fixed for that managed run.

The scan prunes existing generated-directory exclusions and does not follow symbolic links.
Both transfer directions use the discovered paths as literal exclusions.
Snapshots keep discovered paths in their literal `ignoredPaths` matcher, separately from configured exclusion patterns.
Serialized in-memory baselines retain these paths when a clone marker or scratch policy later changes.
A clone at `foo/*` excludes only that directory. Remote edits to `foo/source.txt` still return normally.
Restore combines discovered paths with existing ignored paths, including disk-backed ignore manifests.
Restore scans also retain caller exclusions from the supplied baseline.
Saved literal exclusions reach the download archive before data enters the staging directory.
After Git import, removal checks each path ancestor and skips paths below a symlink or a non-directory.
This protects files outside the workspace when a committed symlink differs from the local directory overlay.
Removal still deletes a leaf symlink itself and treats names with glob characters literally.
Baseline capture omits these paths, and restore preserves their local contents.
New nested repositories on the remote also stay out of the downloaded archive.
If a previously ordinary directory becomes a clone, restore preserves its local version.
Skipped paths remain excluded through the rest of the managed run, even if their `.git` marker disappears.

Each skipped path produces one progress log entry per managed run, with its `du -sk` size in KiB.
If size collection fails, the log reports `unknown` and the path stays excluded.
Size collection uses a separate five-second budget after discovery records all exclusions.
Restore discovery prunes saved literal exclusions before reading their contents.
Without a progress sink, the entry goes to the server console.
Paths use JSON quoting so a newline in a filename cannot create a second log line.
Direct prepare/restore callers can share a `syncPolicy` to retain this per-run state.
Runtime assets and in-place workspaces do not use this workspace filter.

Git history still transfers as a bundle, including committed scratch content in that history.
The working tree omits skipped directories. Their tracked files receive Git's `skip-worktree` index flag first.
An ordinary `git add -A` then preserves these files in subsequent commits.
This filter reduces workspace copies, not Git history size.

Sync-back preserves symbolic link text exactly, including relative targets.
Copies keep link text verbatim. Baseline merges preserve excluded local files.
An empty staging target uses a direct copy to avoid another manifest and file-flush pass.

A Git bundle download completes after both the stream pipeline and SSH succeed.
The pipeline owns stream termination and reports stream errors.
An `early EOF` or `index-pack` error causes one fresh export and download attempt.
A second failure stops restoration before Git integration.

Run the regression checks with Node.js 24:

```sh
pnpm exec vitest run --no-file-parallelism \
  packages/adapter-utils/src/ssh-download.test.ts \
  packages/adapter-utils/src/ssh-sync-regressions.test.ts
```

The fork workflow `synthiq-ssh-sync.yml` also checks the existing SSH fixture,
the managed runtime, the baseline merge, remote tracking refs, workspace scheduling, and adapter types.
The `synthiq-ssh-workspace.yml` repository verification runs six isolated test shards
on the exact PR head. Shard 1 also runs all-package typechecks and the full build. Its required
`repository-verification` check succeeds only when every shard succeeds.
This uses the passing fork release test pattern: one Vitest process per shard,
serial test files, and isolated workers. The previous unsharded launcher exceeded
the 150-minute test budget while tests were still passing.
The 2026-11-02 (VLAT) coverage check found all 2,338 test files in the six shards,
with no missing or duplicate files. All 164 serialized suites remained covered.
The shard file counts were 390, 390, 390, 390, 389, and 389.
The existing fork release test steps completed in 14m47s to 30m02s.
These release timings are a baseline, not a measurement of this workflow.
Check the aggregate gate with
`node --test .github/scripts/tests/ssh-workspace-verification.test.mjs`.
The restart-stop test waits for the provider to report readiness before stopping it.
A writer marker exists before its systemd scope starts, so marker presence is not readiness proof.
The continuation fixture uses the full company UUID in its issue prefix to prevent collisions from truncated IDs.
The snapshot tests check that hashing stays outside the main thread.
The public SSH API remains in `ssh.ts`. Implementation modules retain the released module layout.
The regression transport executes real Git and tar commands through a local SSH substitute.
Separate stream tests control the sink speed and the SSH exit order.
These tests do not prove production behavior under concurrent load.

## Run environment delivery

The SSH launcher sends all explicit environment values through standard input.
This includes secret bindings with custom variable names.
Each launch uses a unique directory under `/tmp` with mode `0700`.
The environment file has mode `0600`.
The remote wrapper reads the file after the login profiles.
It disables verbose shell output and execution tracing before it reads the values.
It removes the file and directory before it starts the provider.
Cleanup also attempts removal when the launch fails or never starts.
An unavailable SSH connection can prevent that final cleanup attempt.
An upload input error rejects the command after the SSH process closes.
This preserves cleanup and prevents an unhandled broken-pipe error.

The same path serves provider launches and managed runtime commands.
Provider standard input remains available in both `in_place` and copy modes.
The systemd scope retains the static `Paperclip SSH writer` description.
Environment values do not appear in the SSH or provider launch arguments.

The `ssh-environment.integration.test.ts` suite starts a real SSH server and systemd scopes.
It checks environment delivery, standard input, file removal, process arguments, unit properties, and journal records.
The fork workspace workflow requires these checks on Linux with a systemd user manager.
