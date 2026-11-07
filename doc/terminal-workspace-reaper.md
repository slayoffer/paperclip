# Terminal workspace reaper Git checks

The reaper checks the source issue tree before it inspects Git. It skips Git
inspection when the source or a descendant is not terminal. It also skips Git
inspection during the configured cooldown. The latest terminal timestamp in
the tree sets the cooldown anchor.

Each service instance retains dirty Git verdicts for six hours. The cache holds
at most 5,000 entries. A workspace row change invalidates its verdict. Expiry or
a process restart permits another Git inspection. A cached dirty verdict can
only skip a workspace. It cannot authorize an archive or cleanup.

The archive path still checks lifecycle state under its lock. Cleanup still
requires a fresh Git check with the expected HEAD and branch.

Counter order follows the checks. Non-terminal trees count as
`skippedNonTerminalTree`. Workspaces in cooldown count as `skippedCooldown`,
even if they are dirty or undelivered. Cached and fresh dirty results count as
both `skippedDirty` and `skippedUndelivered`.

Run the affected service tests separately from `server/`:

```sh
pnpm exec vitest run src/__tests__/terminal-workspace-sweep-git.test.ts
pnpm exec vitest run src/__tests__/execution-workspaces-service.test.ts
```
