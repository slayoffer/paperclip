# MCP package checks

Both runner capability inventories record line numbers from `src/tools.ts`.
If an edit moves a tool definition, the full typecheck can report contract
drift or stale `sourceAnchor` fields.
Run the runner's `generate:capability-contract` and `generate:capability-inventory` scripts.
The second script needs the external eval corpus through `PAPERCLIP_EVALS_ROOT`.
For MCP-only updates without that corpus, use its `buildMcpInventory`,
`encodeInventory`, and `renderDocumentation` helpers with the committed
normative inventories. Keep the normative inventories unchanged.
Commit the generated source links, documentation, and checksum.
Run both `check:capability-contract` and `check:capability-inventory` scripts.
