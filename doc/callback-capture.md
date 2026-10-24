# Bounded SSH callback capture

`scripts/callback-capture/callback-capture.mjs` prepares one diagnostic capture.
It does not correct a callback failure or authorize a host operation.
An authorized operator must approve the exact launcher archive and manifest before execution.

The launcher uses the installed controller modules.
It checks their SHA-256 hashes before it imports executable modules.
It also checks the build stamp and Node version.
The operator must compare the running image digest with the approved manifest.
The manifest digest is an expected value. The launcher cannot verify the container registry identity itself.

## Prepare the manifest

Create a JSON manifest outside the installed application directory.
Use these fields:

| Field | Value |
| --- | --- |
| `captureId` | A new capture UUID. Never reuse an earlier capture identifier. |
| `companyId` | The diagnostic company's UUID. |
| `environmentId` | The registered SSH environment UUID. |
| `issueId` | The diagnostic issue UUID. The probes write only to this issue. |
| `issueKey` | The incident key, such as `SYNA-2370`. |
| `authorAgentId` | The agent UUID for the existing approved run authentication. |
| `host` | The registered SSH host. |
| `remoteWorkspaceRoot` | The registered remote root. |
| `remoteScratchRoot` | A separate absolute scratch root. It must not overlap the registered root. |
| `environmentUpdatedAt` | The observed environment timestamp, in ISO format. |
| `apiOrigin` | The controller's HTTP origin on `127.0.0.1`. Confirm its port before approval. |
| `revision` | The installed controller's full commit SHA. |
| `imageDigest` | The independently checked image digest, with the `sha256:` prefix. |
| `nodeVersion` | The expected executable version, including the `v` prefix. |
| `hashes` | An object with each `REQUIRED_FILES` path and its approved SHA-256 hash. |

`REQUIRED_FILES` is exported from `callback-capture-policy.mjs`.
Reject a missing hash. Do not replace a failed hash with a newly observed value during execution.
Keep credentials, raw configuration, and environment values outside the manifest.

The remote directory is `<remoteScratchRoot>/<issueKey>/<captureId>`.
Creation requires a new directory and an exclusive ownership marker.
The environment driver receives an in-memory copy with this directory as `remoteWorkspacePath`.
The launcher does not change the registered environment or attach to an agent session.
It records the new lease identifier before the first probe.

## Database and process startup

Use the existing controller container and its installed TypeScript loader.
The process requires an existing `DATABASE_URL`, `PAPERCLIP_API_KEY`, and `PAPERCLIP_RUN_ID`.
Check their presence without printing their values.
If the database URL is absent, stop. Do not start a database or import `server/dist/index.js`.
The launcher does not initialize PostgreSQL, apply migrations, or load the server configuration module.

The identity check reads files only:

```sh
node /capture/scripts/callback-capture/callback-capture.mjs --check /capture/manifest.json /app
```

After exact approval, use an existing separate local output parent:

```sh
node /capture/scripts/callback-capture/callback-capture.mjs --execute /capture/manifest.json /app /capture/output
```

The launcher creates `<output>/<captureId>` with mode `0700`.
Its parent starts one detached diagnostic process through this argument vector:

```text
node --import /app/server/node_modules/tsx/dist/loader.mjs <launcher> --child <manifest> /app <output-directory> <manifest-hash>
```

It sends termination at 120 seconds and kills only its child group at 150 seconds.
The child bounds active capture to 120 seconds and cleanup to 30 seconds.
The remote supervisor also has a finite deadline.
It owns the gateway child group and never kills a PID from an earlier capture.
Existing SSH helpers retain their normal temporary authentication-file cleanup.

## Probes and evidence

The launcher selects the `queue_v1` bridge and the SSH command runner.
It leaves production bridge timeout and retry settings unchanged.
The queue worker bounds time without a completed request stage.
Each completed read, authorization, handler, publication, or removal stage renews that deadline.
The watchdog also uses completed stages as progress.
The combined duration of healthy stages does not cause recovery for the next queued request.
A stalled stage still starts recovery. Existing mutation guards prevent a competing retryable response after handler ownership.
It uses a new loopback port and refuses the original incident port.
It performs three sequential requests without application retries:

1. Read the diagnostic issue.
2. Write one audit comment with the capture UUID as `clientRequestId`.
3. Read the saved comment and check its identifier, author, and exact body.

Each HTTP request has a ten-second deadline.
The first error, identity difference, trace limit, or unknown write outcome prevents further probes.
The local trace includes operation parents, UTC timestamps, monotonic durations, request identifiers, and safe results.
Queue reads, host forwarding, response publication, and SSH commands have separate boundaries.
The trace excludes command text, command output, request bodies, response bodies, headers, and environment values.
It permits at most 512 events and 256 KiB.

The local output contains `identity.json`, `trace.jsonl`, `result.json`, and `process.json`.
Identity evidence includes the module hashes, source revision, executable version, and controller boot identity.
The operator must preserve these files even when the diagnostic process fails.
An exit code alone does not prove successful cleanup or a callback cause.

Cleanup stops the worker before it requests the remote supervisor to stop.
It seals the diagnostic runner and waits for its outstanding commands.
An uncertain command outcome prevents directory removal and lease release.
SSH exit 255, signal termination, and an absent or invalid exit status remain uncertain.
These results do not confirm remote command termination. Preserve the directory and lease until termination is confirmed.
It requires the supervisor's stop acknowledgement before it removes the owned directory.
It then releases only the diagnostic lease.
Unconfirmed cleanup retains the directory and lease identifiers for the operator.
A timed-out root or lease operation remains uncertain. The launcher does not repeat it.

All three requests and their required stage records must pass for `not_reproduced`.
That result does not establish a historical cause or close an incident.
An incident still requires affected-worker verification after its correction.

## Review and tests

```sh
node --test .github/scripts/tests/callback-capture.test.mjs
```

The upstream trusted workflow includes this test through `.github/scripts/tests/*.test.mjs`.
The fork release workflow runs it through `packages/adapter-utils/src/callback-capture-diagnostic.test.ts`.
The tests use temporary local files, simulated runtime boundaries, and real child processes.
They do not create a live lease, access SSH, or write a Paperclip comment.

Exact execution approval must include the archive hash, manifest hash, host, environment, paths, deadlines, and single comment write.
It must include temporary diagnostic authentication and cleanup.
The CTO must use `credentialOperation: true` when its card includes the generated bridge token or existing secret resolution.
Repository review and a merge approval do not grant capture execution authority.
