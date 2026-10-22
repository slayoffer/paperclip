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
