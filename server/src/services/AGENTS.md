# Service guidance

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
