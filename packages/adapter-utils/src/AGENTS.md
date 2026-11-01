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

## SSH workspace exclusions

Workspace filters must apply before tar creation and baseline capture.
Filter skipped paths from supplied baselines before restore. Otherwise, an omitted remote directory can remove local files.
Keep discovered paths literal in tar arguments. Directory names can contain glob characters.
Share one sync policy across preparation and restore to log each skipped path once per managed run.
Do not apply workspace filters to runtime assets or in-place execution.
The scratch regression cases register through `ssh-sync-regressions.test.ts`, which the existing fork workflow runs.
