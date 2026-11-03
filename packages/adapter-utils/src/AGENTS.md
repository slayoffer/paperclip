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

## SSH cache restore

Check workspace root cache markers before restoring nested project repositories.
Skip separate nested repository uploads when their workspace root is tagged.
Check the `.paperclip-repositories` container marker before separate child transfers.
Decode SSH text as a stream so split UTF-8 characters retain their original paths.
A marker can appear after baseline capture. Child scans cannot see that marker.
Send restore archive commands through stdin. Large exclusion lists can exceed
the operating system limit for one SSH command argument.
Preserve literal ignored paths when serializing in-memory baselines.
Otherwise, a removed cache marker permits restore to overwrite excluded local data.
