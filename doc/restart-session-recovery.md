# Legacy CLI restart recovery

Paperclip saves a checkpoint when Codex or Claude reports its CLI session ID.
The checkpoint contains the company, agent, issue, session parameters, task key, and execution workspace.
It stays in the local run record. It does not contain credentials or prompt text.

On graceful shutdown, Paperclip stops a checkpointed provider and retains the running row and workspace.
After startup, the orphan reaper claims an expired controller and resumes the same run ID.
The adapter receives the saved session and a short restart prompt.
The adapter cannot replace a missing restart session with a fresh session.

The orphan reaper owns process-loss recovery for legacy runs with a controller or checkpoint.
The stale-lock sweeper retains these runs and their task locks, even after the controller lease expires.
Its terminal write also checks for a controller or checkpoint saved after the sweep read.
Terminal tasks and older unmanaged runs retain the existing cleanup path.

Managed local sessions retain their transcript directories before temporary home cleanup.
Recovery restores these transcripts into the replacement provider home. Authentication and configuration files stay excluded.

Recovery preserves the session storage key. This includes owner session keys from the optional owner session mode.
If the configured session scope changes before recovery, the saved run requires reconciliation.
Recovery does not create a second session registry.

The reaper must first find no live provider PID or process group.
A local run without saved process identifiers requires an explicit provider-stop receipt.
Missing process metadata alone cannot prove that a detached provider stopped.
For SSH runs, a local wrapper PID cannot prove remote termination.
Automatic SSH resume therefore requires a confirmed provider stop and completed workspace restore before shutdown.
On recovery, the SSH driver checks the retained lease's endpoint and verifies termination again.
It releases that lease and its exact worktree lock before acquiring the replacement lease.
This preserves the in-place workspace path. Without this release, lock contention selects copy mode and Codex rejects the changed session identity.
A failed termination check keeps the lock and requires reconciliation.
A hard SSH failure without these receipts uses reconciliation.
Sandbox checkpoints use reconciliation because sandbox preparation replaces the provider store.

A missing session, missing workspace, changed account, changed adapter, or unverified provider stop uses the existing reconciliation path.
The run records the reason in `resultJson.restartRecovery`.
Conversation retry policy cannot remove this reconciliation hold after a failed restart resume.
Recovery permits at most three controller claims per run.
Each claim permits one budget admission for resumed provider work. Concurrent or repeated admission is rejected.
The claim clears the old finalization deadline because the run will execute provider work again.
Fallback writes require the expected controller and a running row. They preserve the attempt count.
Normal budget, pause, issue ownership, workspace, and approval checks still apply.
Verified bootstrap failures retain their existing retry path when no provider execution evidence exists.

The resumed run reuses its existing budget reservation. Each restart dispatch requires
the current controller lease, saved attempt number, and provider session ID.
The dispatch gate checks this claim under both lock phases and admits it only once.
A call without the claim cannot dispatch again after a restart. Current budget and
issue-ownership checks still apply before the adapter starts.

Operators must verify a deployed release with a controlled restart and record the affected run IDs.
Tests do not replace this live deployment check.

An explicit wake with `resumeFromRunId` uses the saved run's canonical issue binding
before admission. Native and first-class issue columns take precedence over the saved
context. The saved task key still selects the provider session and its workspace.
Caller issue or task IDs must match the saved issue, and an explicitly supplied task
key must match the saved key. A conflict returns HTTP 409 with `resume_issue_mismatch`.
Omitting these fields does not bypass the issue budget or owner-parking checks.

`server/src/__tests__/restart-live-runs.test.ts` stops six live Codex and Claude runs.
It checks that every saved session resumes once when lock cleanup precedes or overlaps recovery.

`server/src/__tests__/ssh-restart-resume.test.ts` uses the real Codex adapter and a loopback SSH fixture.
A fixture executable emits Codex protocol events without a provider API call.
The test checks shutdown receipts, preserved session identity, one resumed invocation, and successful completion of the same run.
The fixture omits the Paperclip API callback bridge. It requires embedded PostgreSQL, SSH, and user systemd scopes.
