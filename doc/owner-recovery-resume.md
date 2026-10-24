# Owner continuation after recovery

The server sets `PAPERCLIP_OWNER_RECOVERY_RESUME_ENABLED` to on by default.
Set it to `false` or `0` to restore the previous prompt contract.
This option is independent of `PAPERCLIP_OWNER_SESSIONS_ENABLED`.
It requires no database migration.

A recovery wake for the current task owner can permit normal source work.
The server reads the current company, issue, owner, recovery action, and source run.
The current run must hold the issue execution lock before it can receive this contract.
Source-scoped owner claims use the normal execution lock while the switch is on.
A continuation waits until an earlier execution and its cleanup release the issue.
Eligible source-scoped turns also use normal checkout.
It marks an eligible wake with `recovery.executionMode: "owner_resume"`.
The adapter then instructs the owner to inspect saved progress and continue the task.
This contract replaces the generic instruction that forbids deliverable work during recovery.
It applies to fresh sessions and resumed owner sessions.

Eligible causes are process loss, server shutdown interruption, duplex channel loss,
stranded assignment, and self-owned disposition repair.
The issue must remain `todo` or `in_progress` with the same agent owner.
A referenced source run must belong to that company, issue, and agent.
Workspace restore failures and failed restart reconciliation retain the repair contract.
An active board-owned action also retains the repair contract.
A resolved historical action does not represent an outstanding board decision.
Another agent's recovery task does not gain authority to perform the source work.

Callback failures can leave a successful model turn without a recorded task disposition.
The bounded disposition repair already permits productive work.
The new contract removes the contradictory outer restriction from that repair turn.
The owner can make the required source change before the unchanged-source budget expires.
This change does not increase or reset that budget.

The normal owner contract requires a board decision for a real conflict, missing
credential, host operation, or another required approval.
It does not require a card merely to restore normal owner execution.
An absent active recovery action does not require a recovery resolution API call.
An obsolete source-scoped wake can resume the current owner when no action or cause remains.

Dispatch still applies its process ownership, workspace, pause, budget, and approval gates.
The restart controller still requires its existing termination and session evidence.
The owner-session feature still uses its existing project key and serialized admission.
The prompt flag cannot clear a recovery hold or authorize replay of uncertain actions.

Run these checks on an approved build host:

```sh
pnpm exec vitest run server/src/__tests__/owner-recovery-resume.test.ts packages/adapter-utils/src/server-utils.test.ts --no-file-parallelism
pnpm exec vitest run server/src/services/legacy-restart-recovery.test.ts server/src/__tests__/owner-session-guards.test.ts server/src/__tests__/owner-sessions.test.ts server/src/__tests__/issue-recovery-actions.test.ts --no-file-parallelism
pnpm exec vitest run server/src/__tests__/owner-recovery-execution-lock.test.ts server/src/__tests__/heartbeat-auto-checkout.test.ts --no-file-parallelism
pnpm -r typecheck
```
