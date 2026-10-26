# Runtime admission cap receipt

The Linux application process captures `PAPERCLIP_MAX_RUNNING_RUNS` once.
Capture occurs when the health router is constructed or admission first reads the value.
Environment loading precedes router construction during normal startup.
Admission and health use `getProcessRunningRunsCap` from `server/src/services/instance-run-cap.ts`.
Later environment changes and router recreation cannot change this value.
A new application process reads its own value.
The existing parser and uncapped fallback remain unchanged.
Agent limits, scheduling locks, and leases retain their existing behavior.

Send a direct loopback request inside the application network namespace:

```sh
curl --fail 'http://127.0.0.1:3100/api/health?capNonce=probe-1'
```

The response includes `runtimeCap` with exactly these fields:

| Field | Definition |
| --- | --- |
| `schema` | Literal `paperclip.runtime-cap.v1`. |
| `nonce` | The request's single, nonempty `capNonce` string, at most 128 UTF-16 code units. |
| `pid` | Integer application PID inside its PID namespace, from `process.pid`. |
| `startTicks` | Positive safe integer from `/proc/self/stat`, field 22. |
| `cap` | Positive safe integer from the captured admission value. |
| `immutable` | Literal `true`. |

The receipt needs no board session, including in authenticated mode.
The socket peer must be `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`.
Requests with `Forwarded` or standard `X-Forwarded-*` headers receive `403`.
The endpoint ignores supplied host names and proxy-derived client addresses for this check.
An operator proxy must preserve forwarding headers and must not strip them for this probe.
This boundary does not distinguish a direct client from a proxy that removes all forwarding metadata.

Malformed or repeated nonces receive `400`.
An uncapped, invalid, or unrepresentable cap receives `503` without a receipt.
Unavailable or malformed Linux process metadata also produces `503` without a receipt.
These failures do not change admission or stop ordinary health probes.
Receipt responses use `Cache-Control: no-store`.
Requests without `capNonce` retain the existing health contract.
A database failure retains its `503` status even when process evidence is available.

The receipt proves the current process value.
It does not prove a cap activation time or a continuous observation window.
The host collector must bind the namespace PID and ticks to its host process.
It must independently establish the container, image digest, revision, and lifecycle history.
Source delivery authorizes no installation, restart, cap change, or trial.
