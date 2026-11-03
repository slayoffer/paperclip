# Standing driver continuation

An `in_progress` issue has a valid continuation when its assignee has an enabled
heartbeat timer with a positive `intervalSec`, and `heartbeat.driverIssueId`
resolves to that issue. The reference can be a UUID or a case-insensitive issue
identifier. Resolution uses the same company, assignment, and dependency checks
as timer dispatch.

The agent and its reporting chain must also permit execution. A saved enabled
timer does not qualify when the scheduler cannot invoke its agent.

Recovery does not request a disposition repair or an unblock deadline for this
issue. The timer owns its next execution. A saved run flag alone does not qualify
the issue. Recovery checks the current assignment and timer configuration.
An accepted native result that records a task or current-track blocker keeps
the existing blocker repair path. A timer does not override that blocker.

The next stranded-issue recovery pass resolves an existing
`deliberate_wait_without_target` action with outcome `restored` and resolution
note `standing_driver_timer_continuation`. This includes an exhausted action
owned by the board. Other action kinds are not resolved by this rule.

A disabled timer, a non-positive interval, a different driver, an unassigned
issue, or a status other than `in_progress` retains the existing recovery behavior.
A queued legacy disposition repair also checks the timer before dispatch.

Regression tests: `server/src/__tests__/recovery-standing-timer.test.ts`.
