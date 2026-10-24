# Sandbox callback queue

The file transport relays sandbox API calls through request and response files.
The HTTP/2 transport uses a separate path.

## Request lifecycle

`PAPERCLIP_SANDBOX_CALLBACK_QUEUE_V2_ENABLED` defaults to `true`.
Set it to `false` or `0` to restore the prior queue lifecycle and default deadlines.
The host forwards the switch to the generated sandbox gateway.
No database migration is necessary.

With the switch on, the gateway uses this sequence:

1. Write a complete request to a temporary file.
2. Rename it atomically to `requests/<id>.json`.
3. Include an absolute `expiresAt` timestamp in the immutable request.
4. Wait for the host to write a complete response through atomic rename.
5. Read and validate the response before acknowledging the request.
6. Rename the request to `<id>.json.acked` and remove that acknowledged entry.
7. Remove the consumed response.

The worker retains a completion guard until the request leaves the pending list.
A delayed cleanup cannot cause a second handler call for the same request.
The gateway can finish acknowledgement even if the host cannot remove remote files.
Existing requests without `expiresAt` retain the prior host-removal path.

Cleanup removes acknowledged entries and expired requests.
An old modification time does not expire a request with a future `expiresAt`.
The gateway checks expiry before deleting a request after a response error.
It also runs cleanup once per second, or sooner for a shorter response deadline.
Queue admission runs the same cleanup when the queue reaches capacity.
Legacy entries without a deadline use their modification time and the response timeout, plus two seconds.
The publisher puts the deadline first in the envelope.
Cleanup reads at most 128 metadata bytes per entry.
Concurrent admission checks and the periodic timer share one cleanup pass.
They do not allocate copies of the queued request bodies.

The worker checks expiry before authorization and again before starting the API operation.
An expired request does not start a new host mutation.
A timeout after dispatch can leave an uncertain result.
The existing non-retryable outcome and response fences still apply.
A handler failure after mutation dispatch also returns an indeterminate outcome.
This includes the API forwarder's independent timeout before response headers arrive.

## Default deadlines

| Operation | Switch on | Switch off |
| --- | ---: | ---: |
| One host queue control call | 30 seconds | 10 seconds |
| One full request transaction | 90 seconds | 10 seconds |
| Worker watchdog | 100 seconds | 20 seconds |
| Gateway response wait | 120 seconds | 30 seconds |

The full transaction includes several remote control calls and the API handler.
Its budget must exceed one control-call budget.
The watchdog counts a completed queue listing as progress before the transaction starts.
The gateway budget leaves time for a terminal receipt after the worker deadline.
Explicit worker test or embedding overrides still apply.
An explicit `iterationTimeoutMs` also sets the transaction budget unless `requestTimeoutMs` overrides it.
An explicit gateway `responseTimeoutMs` changes both its wait and the published expiry.
Keep custom deadlines in the same order as the defaults.

The prior worker applied one 10-second limit to the whole transaction.
That limit could reject a live transaction before its individual control calls expired.
Its recovery pass then read files that the gateway could remove during timeout cleanup.
Atomic publication already existed. This change adds acknowledgement and explicit expiry to the later stages.

## Local verification

```sh
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-queue-lifecycle.test.ts
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-queue-review.test.ts
pnpm exec vitest run packages/adapter-utils/src/sandbox-callback-bridge.test.ts packages/adapter-utils/src/sandbox-callback-bridge-recovery.test.ts packages/adapter-utils/src/sandbox-callback-bridge-body.test.ts packages/adapter-utils/src/http2-bridge-server.test.ts --no-file-parallelism
pnpm --filter @paperclipai/adapter-utils typecheck
```

The tests use local files, virtual time, and a local generated gateway process.
They do not connect to a Paperclip instance or a sandbox host.
