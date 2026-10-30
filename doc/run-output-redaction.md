# Run output redaction

Heartbeat persistence masks credential shapes and registered values before storage.
The policy covers `resultJson`, `error`, `stdoutExcerpt`, `stderrExcerpt`, and stored run-log chunks.
It also masks the execution error record before the server logger receives it.

The run registry stores encrypted material in `contextSnapshot.paperclipSecretRedactions`.
Context updates preserve this server-owned field with a database expression.
Concurrent registration uses a row lock and retains distinct values.
The registry remains specific to the company and run.

Run keys and runtime tool keys enter the registry before adapter dispatch.
Runtime MCP bearer values enter it before header delivery.
Each supported local adapter forwards the registration callback to its remote callback bridge.
The bridge awaits registration before transport setup exposes its generated opaque value.
Native GitHub sessions register their broker and bridge values before delivery.
A reused native session registers these values for each new run before activation.

The log writer keeps incomplete lines in memory for each output stream.
It also retains enough text to mask registered values that contain line breaks.
Success, failure, timeout, and cancellation flush the remaining text through the same policy.
Terminal stream tails use the arrival order of their first retained fragments.
Each tail remains one redacted record, including interleaved callbacks from that stream.
A pending line above 65,536 characters becomes a redaction marker.
The writer tracks registered prefixes while it discards the remaining fragments.
Recovery requires a line break outside every partial registered value.
Matching state depends on registered value lengths and does not grow with discarded output.
Each stream keeps separate matching state, including across repeated oversized callbacks.
A complete line still uses the existing chunk-size limit.
Output without line breaks can appear later in the live view.

Registry lookup failure prevents a buffered log write.
A run-row write substitutes redaction markers when registry resolution fails.
It stores `{ "redactionUnavailable": true }` instead of result data in that case.
Ordinary successful masking preserves JSON types, nesting, and neutral data within the existing depth policy.
The depth policy converts subtrees below depth 64 to bounded redacted text.

The fork workflow `synthiq-run-redaction.yml` requires embedded PostgreSQL support.
It checks real heartbeat writes with synthetic values and a local callback bridge.
The lifecycle suite supplies controlled adapter outcomes and reads stored rows and log content.
It does not prove provider behavior, an installed image, or historical cleanup.
The existing [upstream submission](https://github.com/paperclipai/paperclip/pull/16525) remains open.

## Column-level redaction (SYNA-1586)

The `heartbeat_runs` columns `result_json`, `error`, `stdout_excerpt` and `stderr_excerpt` use redacting column types.
See `packages/db/src/run-output-redaction.ts`.
Drizzle calls their encoder on every `insert().values()`, `update().set()` and `sql.param(value, column)`.
Thus a writer that does not call the heartbeat policy still stores redacted output.
The server installs the shape policy at startup (`installRunOutputRedaction` in `server/src/services/run-result-redaction.ts`).
The run log uses the same shape policy.
The shapes include `gho_`/`ghp_`/`github_pat_` tokens, JWTs (also the run `PAPERCLIP_API_KEY`), `pcgw_` gateway tokens,
`pcp_` keys, and credential-named assignments such as `PAPERCLIP_API_KEY=...`.
The display prefix `pcgw_<8 hex>` and the `pcgw_...` placeholder stay visible.

Limits:

- A raw `${JSON.stringify(value)}::jsonb` fragment has no column encoder. Merge with `sql.param(value, heartbeatRuns.resultJson)`.
- The column encoder is synchronous and cannot read the run registry. Exact registered values (opaque keys) are masked
  only by the heartbeat writers, through `redactRunPersistencePatch`.
- `heartbeat_run_events` is not changed. Native PRP event payloads are stored as written because their digests are
  verified again on read. Legacy events go through `redactSensitiveText` and `redactEventPayload` in the heartbeat.
- Workspace operation output (log file and excerpts) uses the run-log shape policy per chunk.
  A value split across two chunks is not masked there.
- Rows written before this change keep their content. Cleanup of old rows needs a separate approval.
