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
Before remote removal, check every ancestor without following symlinks.
Git import can restore a committed symlink where the local overlay has a directory; `rm -rf link/child` follows that link.
Store discovered paths in snapshot `ignoredPaths`, not pattern `exclude` lists.
For example, the literal clone `foo/*` must not exclude its sibling `foo/source.txt`.
When filtering a supplied baseline, combine its existing ignored paths with the discovered paths.
Share one sync policy across preparation and restore to log each skipped path once per managed run.
Do not apply workspace filters to runtime assets or in-place execution.
The scratch regression cases register through `ssh-sync-regressions.test.ts`, which the existing fork workflow runs.
Preserve literal ignored paths in serialized baselines. A later policy or marker
change must not expose previously excluded local files to restore.
Use baseline caller exclusions during restore discovery.
Pass saved literal exclusions to tar as well as the final merge.
Prune saved literal exclusions before discovery reads them.
Optional size collection must not fail a transfer or remove an exclusion.
Record exclusions first. Give size collection its own bounded command and catch its failures.
An absent local restore destination has no exclusions. Continue restore so it can create the directory.
Send scripts with discovered path lists through stdin. Large lists can exceed the SSH argument limit.
Stdin does not remove child-process argument limits. Batch Git pathspecs and removal operands, and use NUL file lists for large tar inputs.
Do not start one removal process per path. Large exclusion lists can exceed the command deadline even when most paths are absent.
Prune retained policy exclusions before every discovery pass, including after clone markers disappear.

## SSH setup failures

Preserve `SshTransportError` through execution-target probes and shell runners.
A generic probe error spends the run's failure budget and can block its issue.
The SSH command wrapper distinguishes remote exit 255 from transport exit 255.
Keep its completion frame when changing remote shell wrappers.
An explicit SSH timeout bounds all attempts and retry delays. Do not raise it to
the connection-timeout default. Readiness polling must pass its remaining budget
to the command runner, or one probe can exceed the readiness deadline.
