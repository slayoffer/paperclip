# Parent dependency notifications

The fork's optional blocked-state integrity rules prevent duplicate parent notifications.
Enable these rules only through the approved release procedure.
The environment switch is `PAPERCLIP_BLOCKED_STATE_INTEGRITY=true`. Its default remains disabled.

When a completed child explicitly blocks its parent, the dependency path owns the parent notification.
The route and native completion paths suppress the separate child-completion wake for that dependency.
Native dependency wakes use the same blocked-cycle key as durable release and recovery.
A completed wake prevents another wake for that same cycle.
Both native and HTTP dependency notifications retain the completed children's summaries.

An unlinked child's completion retains its parent summary notification.
A separate blocked wait prevents that notification while integrity is enabled.
Completed onboarding parents retain their final report notification, including linked children.
The change does not approve cards, remove review holds, or bypass workspace finalization.

Run the regression suite with:

```sh
pnpm exec vitest run server/src/__tests__/dependency-release-wakes.test.ts
```

The suite registers native completion cases from `dependency-release-native.cases.ts`.
It checks one notification after native completion and recovery.
It also checks the disabled behavior, child summaries, outside waits, and transaction rollback.
These tests use a temporary database. They do not prove production latency or deployment readiness.
