# Interaction resolution channel

Read `resolvedVia` with the existing resolver IDs when checking an interaction.
`user_session` identifies a signed-in user session. `board_api_key` identifies a
board key call. `agent_key` identifies an agent key or run JWT. A null value means
the channel is unknown. Do not infer human action from a resolver user ID.

The server sets this field. Request bodies cannot choose it, and retries cannot
replace it. Old rows stay null. This change does not alter resolver permissions.

See [Interaction resolution requests](../../doc/interaction-resolution.md) for
the API contract, TMA relay distinction, and database behavior.
