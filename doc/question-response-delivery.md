# Question response delivery compatibility

Pending deliveries keep a SHA-256 digest of the delivery envelope.
The current envelope excludes synthetic option IDs for custom text answers.
Earlier envelopes included these IDs in non-text answers.

The service accepts the current digest or the exact previous envelope digest.
It reconstructs the previous envelope from the saved interaction and answers.
It sends the current envelope after either digest matches.
It preserves the stored digest, resolver policy, claim fence, and duplicate protection.
A different digest produces `question_response_payload_digest_mismatch` before delivery.
Continuation authorization and source retirement use the same digest matcher.
They preserve company, correlation, actor, and cancellation checks.
This compatibility check needs no migration or stored answer change.

Delivery checks the issue token budget before it claims a pending response.
A budget stop leaves the response pending without a wake receipt, claim attempt, or error retry.
Accepting the issue's budget card retries its pending question responses and resolution continuations after the acceptance commits.
The same delivery fences protect acceptance replays and scheduler sweeps from duplicate admission.
Known holds and suppression reasons from the exact wake invocation keep the answer pending without an error retry.
Both outboxes save a next-attempt deadline. Held wakes retry after 30 seconds, then 60 seconds,
then double the delay up to 30 minutes. The deadline and hold count survive process restarts.
Outbox admission returns the current gate reason without writing skipped wake receipts.
A paused assignee stays pending. A terminated assignee ends delivery with `agent.terminated`;
the resolution outbox records this reason and a failure time.
After a hold is released, the next due retry delivers the saved answer once.
This includes a budget stop that starts after the pre-check, a paused issue tree, disabled wakes, and scheduling suppression.
An old skipped receipt cannot explain a new null wake. Only unexplained nulls consume the five-error retry limit.
The fifth unexplained null records `question_response_wake_skipped` and ends automatic retries.
Native input requests that await their provider session retain their separate pending state.
The sweep traverses pending answers by creation time and interaction ID, then returns to the oldest pending row.
It advances past budget-held rows and checks each issue's budget once per page.
An exception from one question response does not stop the remaining sweep rows.
Budget-grant delivery failures remain pending and do not change the committed acceptance response or stop later row deliveries.

Run the delivery regression tests with:

```sh
pnpm exec vitest run server/src/__tests__/question-response-delivery.test.ts server/src/__tests__/question-response-legacy-authorization.test.ts
```
