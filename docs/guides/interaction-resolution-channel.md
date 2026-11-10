# Interaction resolution channel

Read `resolvedVia` and `resolvedViaKeyId` with the existing resolver IDs.
`user_session` identifies a signed-in user session. `board_api_key` identifies a
board key call, with its actual key ID. `agent_key` identifies an agent key or run
JWT. `chat_channel` identifies a native chat or voice callback; `system` identifies
automatic work. Null means unknown, never human proof.

The server sets both fields. Request bodies cannot choose them. They stay fixed
while the row is resolved; reopening clears them. Old rows stay null. Resolver
permissions do not change.

Only a signed-in `user_session` is human proof unless the operator verifies that
a board key is used exclusively by the TMA. Different key IDs do not prove exclusive
use. Until that check is complete, a TMA board-key resolution is not human proof.
Do not infer human action from a resolver user ID or a native chat callback.

See [Interaction resolution requests](../../doc/interaction-resolution.md) for
the API contract, TMA relay distinction, and database behavior.
