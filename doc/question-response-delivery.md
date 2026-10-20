# Question response delivery compatibility

Pending deliveries keep a SHA-256 digest of the delivery envelope.
The current envelope excludes synthetic option IDs for custom text answers.
Earlier envelopes included these IDs in non-text answers.

The service accepts the current digest or the exact previous envelope digest.
It reconstructs the previous envelope from the saved interaction and answers.
It sends the current envelope after either digest matches.
It preserves the stored digest, resolver policy, claim fence, and duplicate protection.
A different digest produces `question_response_payload_digest_mismatch` before delivery.
This compatibility check needs no migration or stored answer change.

Run the delivery regression tests with:

```sh
pnpm exec vitest run server/src/__tests__/question-response-delivery.test.ts
```
