# Issue token budget

`PAPERCLIP_ISSUE_TOKEN_BUDGET` limits weighted input tokens for one issue.
Accounting includes canonical native, first-class, and legacy snapshot bindings.
The existing cached-token weight and window settings apply to every gate.
Accepting the budget confirmation card starts a new window.

The server checks this budget at wake admission, before automatic retry creation,
and again after preparation before provider dispatch. A queued run can therefore
be stopped if another run uses the remaining budget before it starts. A dispatch
stop records `issue.token_budget_exceeded`, releases the issue execution lock,
and releases an unused monetary reservation. It does not start provider work.
Repeated refusals reuse the pending budget card.

Native restart recovery can reattach to an existing local or remote runner above
the limit. That path reconciles admitted provider work and verifies its ownership;
it does not authorize another provider start. Dead-runner resume and incomplete
bootstrap still pass the budget gate before starting provider work.
When a fresh attempt or an incomplete bootstrap starts with no process or
checkpoint and records no provider events, a refusal records that no provider
work started. A predecessor checkpoint copied during preparation does not count
as provider work in this run. This evidence prevents an unrelated execution-recovery
hold and releases its unused monetary
reservation, including a reservation retained across restart. A resumed run with
earlier provider evidence retains its reconciliation and accounting obligations,
even if it did not previously have a monetary reservation. After cleanup, an
unused native coordinator closes under its exact owner. It retains its controller
generation and history; its bound stop receipt permits a subsequent board Retry.

A board UI Run now or Retry can authorize one run above the limit. Admission
writes that authority into the durable wake receipt. New-run creation, deferred
promotion, or coalescing binds the receipt to its run within that transaction.
The check matches the run, issue, company, agent, and attributed user. Caller payload
and context markers cannot grant this authority. Automatic retry successors do
not inherit it; they need a fresh budget window or a new board action.
An authorized Retry can merge into a deferred receipt only when the attributed
user matches. Otherwise it keeps a separate receipt through promotion, without
changing the actor or authority of the earlier wake.

The regression suite is
`server/src/__tests__/heartbeat-issue-token-budget-retry.test.ts`. It uses a real
database with a one-connection pool and the assembled heartbeat execution path.
Deferred promotion passes that transaction client into session, routine, and
responsible-user lookups so those callbacks do not wait for another pool connection.
`heartbeat-issue-token-budget-native-recovery.test.ts` in the same folder covers
native reattachment, inherited checkpoints, and historical accounting.
`server/src/services/cancelled-native-startup.test.ts` checks settlement ownership,
stop-receipt bindings, provider evidence, and pending cleanup against PostgreSQL.
