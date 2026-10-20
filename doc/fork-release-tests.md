# Fork release tests

The Guild fork tests pull requests that target `synthiq/*` with
`.github/workflows/fork-release-tests.yml`.
The workflow executes the fork's source on one GitHub-hosted `ubuntu-24.04` runner.
Its token has only `contents: read`. Checkout does not retain credentials.
The workflow uses no repository secrets or upstream reusable workflows.
Keep the inherited PR workflows disabled in the fork.

## Checks and limits

The workflow first executes its contract check:

```sh
node --test .github/scripts/tests/fork-release-tests.test.mjs
```

It installs Node.js 24 and `pnpm@9.15.4`.
It uses `pnpm install --no-frozen-lockfile`, as the release branch's PR policy requires.
The runner resolves dependencies without committing a lockfile change.
Then it executes these commands from the repository root:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Each check runs after a successful install, even when an earlier check fails.
A failed check fails the job. The workflow does not suppress command exit codes.
Typecheck and build each have a 20-minute limit. Tests have a 150-minute limit.
The whole job has a 180-minute limit, including installation.
The first workflow run exceeded the original 30-minute test limit during its first group.
Its typecheck and build passed. No test assertion failure appeared before the timeout.
The recorded server timings total about 85 minutes across general and serialized suites.
See `scripts/general-server-shard-durations.json` and `scripts/serialized-shard-durations.json`.
These records omit newer suites and workspace checks, so the full command needs more time.
The test runner executes all groups in order on this single runner.
The larger limits retain finite execution bounds and leave coverage unchanged.
The contract check rejects the original limits and an incorrect summary limit.
A newer test event for the same pull request cancels its previous run.
Ignored label events use separate concurrency groups and cannot cancel tests.
These limits bound configured execution time. They do not guarantee a billing cap.
Browser suites and live provider tests remain outside this workflow.

The job summary records the pull request head, target branch, base commit,
tested merge commit, run URL, and each command's outcome.
The merge commit includes the target branch and the pull request head.
A successful contract check alone does not prove the repository checks passed.
A timeout or failed installation also does not prove a test failure.
Read the command outcomes and logs before making a release decision.
GitHub check annotations identify assertion failures without downloading the complete job log.
The first complete run found two stale board-wake expectations in `agent-live-run-routes.test.ts`.
Those expectations now require the existing `issueBudgetOverride: true` field.
The route behavior and budget rules remain unchanged.

## Action references

These are the workflow's only action references. Both belong to GitHub.
The fork's current selected-action policy already permits GitHub-owned actions.
No policy expansion or repository settings write is part of this change.
The action tags resolved to these commits on 2026-10-19:

| Action and version source | Exact reference |
| --- | --- |
| [actions/checkout v6.0.2](https://github.com/actions/checkout/releases/tag/v6.0.2) | `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd` |
| [actions/setup-node v6.2.0](https://github.com/actions/setup-node/releases/tag/v6.2.0) | `actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238` |

Keep the workflow, contract check, and this table synchronized when changing pins.
The contract check rejects missing commands, mutable or additional actions,
unsafe permissions, secret access, upstream workflow calls, and hidden failures.
Use `actionlint .github/workflows/fork-release-tests.yml` to check the workflow syntax.
The contract check needs Node.js only. It needs no dependency installation.

## Existing pull requests

The standard events are `opened`, `synchronize`, `reopened`, and `ready_for_review`.
The workflow also accepts `labeled` when the added label is `fork-release-tests`.
Other label events skip the job.
This event path permits an existing pull request to retain its head and target.
The workflow must first reach the release branch through the normal review process.
A source merge alone does not emit a new pull request event for another open request.

[Pull request #2](https://github.com/slayoffer/paperclip/pull/2) must retain head
`a197fab4f45f01b5cb27a67a419d0d9a74c184d8` and target `synthiq/2026.1012.0`.
After the workflow merges, obtain approval for the exact label operation on that request.
Then add `fork-release-tests` to emit a fresh event without changing either reference.
If the label needs creation or removal before addition, include those operations in the approval.
Do not close or reopen the request under the rejected configuration confirmation.
Do not re-enable the inherited workflows.

Inspect the resulting run through the GitHub API:

```sh
gh run list --repo slayoffer/paperclip --workflow fork-release-tests.yml --event pull_request
gh run view <run-id> --repo slayoffer/paperclip --json url,headSha,conclusion,jobs
gh pr checks 2 --repo slayoffer/paperclip
```

Record the run URL, request head, tested merge commit, target, and command outcomes
in the task's verification document. Confirm that the run belongs to the expected head.
[GitHub's event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
describes pull request activity types, merge references, and branch filters.
This workflow does not authorize a merge, deployment, settings write, or label mutation.
