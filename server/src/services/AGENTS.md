# Service rules

## Deferred dependency wakes

Durable wake payloads describe the blocker set at release time.
The saved blocker set can differ from the current blocker set during a retry.
Check current blocker membership before reusing a saved resolved-blocker ID.
Use current dependency readiness and its blocked-cycle key for dispatch and duplicate checks.

## Run failure diagnostics

Diagnostics redact unknown inherited environment values, even ordinary words.
On 2026-10-28 (VLAT), `XDG_SESSION_CLASS=user` caused diagnostic messages to redact `user`.
Compare exception messages with the report's redacted message in lifecycle tests.
The persisted run error can retain the original message.

## Pull queue stops

Record an explicit backlog disposition with its parking receipt in the issue transaction.
Keep parking conditions separate from general issue recency. Comments and title edits do not resume a parked issue.
Skip receipts restrict automatic selection only. Normal admission always checks current authority.
Recheck budget, dependency, pause, and recovery gates before reusing an old skip.

## Owner parking

`owner:stopped` and `owner:local-session` are execution stops, not descriptive labels.
Read current company-scoped labels at wake admission, retry promotion, and queued dispatch.
Check before recovery actions and pull selection. Record `issue.owner_parked` when skipping.
A status or assignee change cannot override these labels. Remove both labels to resume agent execution.

## Interaction outbox budget stops

Check the current issue token budget before question delivery claims and resolution wake admission.
A stopped issue keeps pending intents without new wake receipts or question delivery attempts.
Budget acceptance retries both outboxes after commit. Keep acceptance replay protection in that path.
Known admission holds from the exact wake invocation preserve the answer without an error retry.
Use `wakeupForOutbox` for admission reasons without skipped receipts. The outbox is the durable retry record.
Persist a 30-second exponential delay, capped at 30 minutes, for known holds in both outboxes.
Check the deadline in direct delivery and sweep selection. A terminated assignee ends delivery with its reason.
Only unexplained null wakes consume the bounded error retry limit. Old skipped receipts are not current diagnostics.
Advance the pending-answer cursor past budget-held rows. Reuse budget checks only within the current page.
After a budget acceptance commits, clear pending retry deadlines, catch each row failure, and continue.
Catch each question sweep row failure so later answers can proceed.
