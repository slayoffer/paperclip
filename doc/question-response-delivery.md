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
Other null wake results without a durable receipt count toward the five-error retry limit.
The fifth failure records `question_response_wake_skipped` and ends automatic retries.
Native input requests that await their provider session retain their separate pending state.

Run the delivery regression tests with:

```sh
pnpm exec vitest run server/src/__tests__/question-response-delivery.test.ts server/src/__tests__/question-response-legacy-authorization.test.ts
```
