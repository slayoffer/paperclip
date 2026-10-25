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
A later run tested the combined source with a newer release target.
The release target now supplies the missing startup pull-queue mock.
Credential rotation also marks connection health unchecked before the approval snapshot check.
The replay regression verifies rejection at that health gate and after simulated health confirmation.
Both cases execute no provider request. Runtime behavior remains unchanged.
The remote-tool fixture uses a separate helper to limit growth of the existing test file.
The next complete run found five stale assertions after release changes.
The disconnect-retry fixture now includes the company-scoped dependency readiness read.
Its tests still require one base lookup when enrichment fails, including readiness failures.
The Docker test requires permissions in the pack stage before the production copy.
It also rejects a second recursive permission change in the production stage.
These corrections preserve the existing retry, access, and image permission behavior.
A later run found two stale conversation cancellation fixtures in `agent-auth-middleware.test.ts`.
The fixture now returns the stored `conversationMode` and `writesRevoked` scalar values.
Its query mock returns only selected fields, so cancellation tests cannot use omitted JSON payloads.
The tests preserve exact denial codes and read access for stopped runs.
They also confirm write access for active ordinary and conversation runs.
The test entry point imports cases and fixtures from smaller modules.
This split satisfies the commit hook's file size limit.
The database projection and runtime behavior remain unchanged.

## Issue read checks across release updates

The issue read workflow also tests the pull request merge commit.
Its previous checkout used the request head alone.
A newer release workflow then requested three suites absent from an older head.
Vitest passed the seven available suites, but the required benchmark file was absent.
The job failed despite 84 passing tests.
The merge checkout includes the release target and the proposed changes.
Its contract checks every requested suite before dependency installation.
It rejects checkout overrides and requires the benchmark output check.

```sh
node --test .github/scripts/tests/issue-read-workflow.test.mjs
```

This correction keeps the issue read job's action pins, permissions, tests, and limits.

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
Other label events skip the job under the distinct name `Ignored label event`.
Only events that execute the repository checks use `Fork release checks`.
GitHub reports skipped jobs as successful, even for required checks.
The separate name prevents an ignored label from satisfying the release check.
The contract tests evaluate both expressions for standard events, the trigger label, and unrelated labels.
See [GitHub's skipped-job behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions).
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

A later release run found a stale rejection assertion in `IssueDetail.test.tsx`.
The request now includes `expectedRevision` as its fourth argument.
The tests check the saved revision and the absent revision.
Both cases preserve the continuation message assertion.
A separate fixture module keeps the large test file from growing.

A later release run found a race in the callback diagnostic queue test.
The response file can appear before the trace records the completed write.
The test now waits for both the response and its complete trace.
A controlled write completion reproduces the race on each run.
The separate queue test module remains part of the 26-test diagnostic suite.
The correction changes no runtime behavior.
