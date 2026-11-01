# Adapter utilities

## Generated callback gateway

`sandbox-callback-bridge.ts` generates a standalone Node program.
It embeds the source from `sandbox-callback-file-gateway.ts` and `sandbox-callback-queue-lifecycle.ts`.
Keep these sources free of runtime imports inside the generated program.
Test the generated program when you change its source.

A request remains pending until the gateway reads a complete response or the request expires.
An old modification time does not prove that a request with a future deadline is stale.
Retain the worker completion guard until acknowledgement removes the pending entry.
Otherwise, delayed file removal can repeat a completed mutation.

## SSH setup failures

Preserve `SshTransportError` through execution-target probes and shell runners.
A generic probe error spends the run's failure budget and can block its issue.
The SSH command wrapper distinguishes remote exit 255 from transport exit 255.
Keep its completion frame when changing remote shell wrappers.
