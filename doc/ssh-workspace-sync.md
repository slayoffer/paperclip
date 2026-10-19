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
the managed runtime, the baseline merge, and adapter types.
The regression transport executes real Git and tar commands through a local SSH substitute.
Separate stream tests control the sink speed and the SSH exit order.
These tests do not prove production behavior under concurrent load.
