# Legacy CLI restart recovery

Paperclip saves a checkpoint when Codex or Claude reports its CLI session ID.
The checkpoint contains the company, agent, issue, session parameters, task key, and execution workspace.
It stays in the local run record. It does not contain credentials or prompt text.

On graceful shutdown, Paperclip stops a checkpointed provider and retains the running row and workspace.
After startup, the orphan reaper claims an expired controller and resumes the same run ID.
The adapter receives the saved session and a short restart prompt.
The adapter cannot replace a missing restart session with a fresh session.

Recovery preserves the existing task key. This includes owner session keys from the optional owner session mode.
Recovery does not create a second session registry.

The reaper must first find no live provider PID or process group.
For SSH runs, a local wrapper PID cannot prove remote termination.
Automatic SSH resume therefore requires a confirmed provider stop and completed workspace restore before shutdown.
A hard SSH failure without these receipts uses reconciliation.

A missing session, missing workspace, changed account, changed adapter, or unverified provider stop uses the existing reconciliation path.
The run records the reason in `resultJson.restartRecovery`.
Conversation retry policy cannot remove this reconciliation hold after a failed restart resume.
Recovery permits at most three controller claims per run.
Normal budget, pause, issue ownership, workspace, and approval checks still apply.

Operators must verify a deployed release with a controlled restart and record the affected run IDs.
Tests do not replace this live deployment check.
