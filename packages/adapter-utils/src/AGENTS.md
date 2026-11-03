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

Git initialization and clone operations can use empty templates, which omit `.git/info`.
Create that directory before writing its `exclude` file. Otherwise, nested repository setup fails with `ENOENT`.
Initialize sanitized temporary clones with `--template=`. A host template can otherwise copy executable hooks into remote seeds.

Check workspace root cache markers before restoring nested project repositories.
Skip separate nested repository uploads when their workspace root is tagged.
Check the `.paperclip-repositories` container marker before separate child transfers.
Decode SSH text as a stream so split UTF-8 characters retain their original paths.
A marker can appear after baseline capture. Child scans cannot see that marker.
Send restore archive commands through stdin. Large exclusion lists can exceed
the operating system limit for one SSH command argument.
Preserve literal ignored paths when serializing in-memory baselines.
Otherwise, a removed cache marker permits restore to overwrite excluded local data.

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

Run clone and scratch discovery before cache discovery. Prune tagged caches during clone discovery.
Both scanners must skip the other policy's excluded trees before reading their children.
Discover local cache markers before remote scans. Pass those literal paths to both remote scanners.
Send policy scan scripts through stdin. Serialized exclusions can exceed the limit for one process argument.

Git checkout precedes the file overlay. Remove tagged caches and fixed generated paths after checkout. Protect their index entries.
For a tagged root, retain Git metadata and runtime files while removing working-tree content.
Upload size estimation must return zero for a whole-root exclusion before it reads directory contents.
Combine saved baseline paths with the current policy exclusions before every scan, including consecutive local and remote scans.
An absent local restore destination has no exclusions. Continue restore so it can create the directory.
Send scripts with discovered path lists through stdin. Large lists can exceed the SSH argument limit.
Stdin does not remove child-process argument limits. Batch Git pathspecs and removal operands, and use NUL file lists for large tar inputs.
Do not start one removal process per path. Large exclusion lists can exceed the command deadline even when most paths are absent.
Prune retained policy exclusions before every discovery pass, including after clone markers disappear.
Discovery must use the baseline matcher's root-relative exclusion scopes and literal text.
Tar-style suffix matching can hide a nested clone from discovery while its files remain in the baseline and are deleted during restore.
Large NUL-list transfers must use the same parsed scopes and literal values as discovery.
Keep AppleDouble basename matching separate from user exclusion patterns.
In matcher fixtures, only the `*/` prefix and `/*` suffix define scopes.
For example, `*/private` matches a directory segment; `private*` is literal path text.

## SSH setup failures

Preserve `SshTransportError` through execution-target probes and shell runners.
A generic probe error spends the run's failure budget and can block its issue.
The SSH command wrapper distinguishes remote exit 255 from transport exit 255.
Keep its completion frame when changing remote shell wrappers.
An explicit SSH timeout bounds all attempts and retry delays. Do not raise it to
the connection-timeout default. Readiness polling must pass its remaining budget
to the command runner, or one probe can exceed the readiness deadline.

## Snapshot worker and checkpoint scripts

A source module loaded through `tsx` can have a query suffix in `import.meta.url`.
Use its URL pathname to select the TypeScript worker source. A suffix check on
the full URL selects a missing JavaScript worker in a source checkout.
Checkpoint scripts embed exclusion helpers as source. Include each helper's
runtime dependencies, including `parseExcludePattern`, in the generated script.
Test the generated program when an exclusion helper changes.
