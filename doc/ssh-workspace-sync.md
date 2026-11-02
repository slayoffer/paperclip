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

Restore preserves excluded local directories and their contents. It combines
the tags captured before execution with tags present locally or remotely at
restore time. Removing a remote tag does not expose a protected local cache.
A remote tag also prevents deletion of the corresponding local directory.
Replacing a parent that contains an excluded local directory fails before
local changes or Git history integration.
For a tagged workspace root, the baseline records the whole-root `.` exclusion.
Restore skips that workspace before any scan, transfer, or history integration.
This state survives baseline serialization and removal of the local marker.

The tests in `packages/adapter-utils/src/ssh-cache-excludes.test.ts` run real
Git and tar through a local SSH substitute. On base `b411be160`, ignored
`node_modules` and `.cache` stayed out in both directions. An untracked,
tagged `target/` transferred in both directions. The same prepare results
applied to referenced projects. The homelab note that only
`.paperclip-runtime` was excluded does not describe this base.

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
