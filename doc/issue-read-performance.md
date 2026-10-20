# Issue read performance

`GET /api/issues/:id?view=light` returns the persisted issue fields and labels.
The response omits derived detail fields. It does not resolve inherited goals.
The normal read remains the default. Both views use the same access checks.
The light response does not revalidate recovery actions.

Use the full read for ancestors, project and goal bodies, documents, references,
blocker attention, review attention, recovery state, and work products.
Use `getLightIssue` from `ui/src/api/issue-light.ts` for the light contract.
Both views return a `Server-Timing` header.

The full read shares agent data within one request. The first agent lookup reads
the company agents and monthly costs in two queries. Later lookups use that
batch. The batch does not persist between requests or cross database connections.

Run authentication, identity capture, event binding, runtime progress, and watchdog reads use
narrow projections. Authentication uses stored cancellation and conversation
flags. Credential operations can still request the context they need.
The activity query reads stored issue and task identifiers through the
`heartbeat_runs_company_agent_activity_idx` index.

## Migration

Migration `0306_futuristic_lethal_legion` adds stored generated columns.
PostgreSQL computes these values for existing rows and future writes.
The migration combines the columns in one table rewrite.
It also creates a covering index for company, agent, creation time, and task ids.
The migration needs an exclusive table lock during the rewrite.
The release operator must schedule this work for the instance.
This code change does not authorize a live deployment.

Large results remain in `heartbeat_runs.result_json`.
Moving historical results needs a separate storage and retention design.

## Verification

Run the focused regression tests:

```sh
pnpm exec vitest run server/src/__tests__/issue-light-read-routes.test.ts server/src/__tests__/issue-read-performance.test.ts server/src/services/agent-read-batch.test.ts
```

The database fixture uses 128 runs. Each run starts with a 143 KB result and a
40 KB context. Random bytes prevent compression from hiding the read cost.
The HTTP fixture has nineteen agents, six ancestors, eight blockers, and ten documents.
The test uses eight concurrent readers. It records 40 requests per view
and excludes five warm requests. The fixture also checks the index plan,
company boundaries, cancellation, and the agent query count.
Set `PAPERCLIP_ISSUE_READ_BENCHMARK_OUTPUT` to save its measurements as JSON.
These fixture measurements do not prove production latency.

After the release operator deploys the change, repeat the original measurements
with five to eight active runs. Record light p95 below 200 ms and full reads
below 500 ms. Preserve the database size, request count, response sizes, and load.
