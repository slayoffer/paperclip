# Delegation, dependencies, and signoff

A larger task can coordinate child work, dependencies, reviewers, and execution controls while preserving a clear owner and a traceable completion decision.

Implementation: [task thread](../ui/src/pages/IssueDetail.tsx), [execution policy](../server/src/services/issues.ts).

## Sub-features

- `delegation`: inspect parent/child tasks and the original request behind delegated work.
- `dependencies`: show blocking tasks and wake eligible work when prerequisites resolve.
- `signoff`: apply the configured implementation/review completion policy.
- `tree-control`: pause or resume a task tree without bypassing its gates.
- `pull-queue`: select ready assigned work when an owner becomes idle. See the [guarded queue](../doc/pull-queue.md).

## How to get to it (user POV)

### `task-relationships`

Open the task’s parent/child and dependency links in task detail.

### `review-and-controls`

Inspect the task’s execution policy and available review, pause, resume, or stop controls.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a parent, child, and dependent task plus implementer/reviewer agents. Record execution policy and use a disposable tree.

### `task-relationships`

Automated: [dependency wakeups](../server/src/__tests__/issue-dependency-wakeups-routes.test.ts) checks server behavior; visual relationship navigation remains a manual check.

Automated: [pull queue](../server/src/__tests__/heartbeat-pull-queue.test.ts) checks guarded selection, real-work counts, ghost release, and monitor protection. Deployment latency requires a separate measurement.

Automated: [queue skip and parking regressions](../server/src/__tests__/heartbeat-pull-queue-gap.test.ts) checks progress past skipped heads and durable backlog stops.

Automated: [owner parking](../server/src/__tests__/issue-owner-parking.test.ts) checks label stops at admission, recovery, selection, retry promotion, and dispatch.
The [assignment route tests](../server/src/__tests__/issue-assignee-invokability-routes.test.ts) check blocked reassignment without an implicit resume.

Manual: Block one task on another, finish the prerequisite, and observe the dependent task’s eligible continuation. Follow parent/child links back to the source request. Verify no duplicate run or false parent completion occurs.

### `review-and-controls`

Automated: [execution policy](../server/src/__tests__/issue-execution-policy.test.ts), [tree control](../server/src/__tests__/issue-tree-control-service.test.ts), and [signoff browser suite](../tests/e2e/signoff-policy.spec.ts) target these layers. A linked suite is not a claim that its current run is green.

Manual: Complete implementation under a review-required policy and confirm it waits for the required review outcome. Exercise rejection and later approval. Pause the parent while child work is pending, then verify resumption respects budget and ownership gates.

## Gotchas

- Review completion and task completion are different events under some policies.
- Pausing a tree must not be “tested” by changing statuses until the screen looks quiet.
- Use [questions and approvals](./questions-and-approvals.md) for decision forms and [recovery](./recovery.md) for interrupted work.
