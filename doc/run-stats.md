# Aggregate run statistics

`GET /api/companies/:companyId/run-stats` returns hourly counts from `heartbeat_runs`.
The route enforces company access. Board users retain access.
Agents require an explicit `stats:read` permission grant and active company membership.
Use the existing member-permissions administration route to grant this permission.
The route grants no permission to read run history or change data.

Required query parameters are `from` and `to`, as ISO timestamps with a time-zone offset.
The range includes `from` and excludes `to`. It uses `created_at`, rather than execution start time.
The maximum range is 14 days. Buckets start at each UTC hour.
The first and last buckets can cover partial hours.

Optional parameters:

- `bucket=hour` is the only supported bucket size.
- `groupBy=status|errorCode|agentId` selects the group. The default is `status`.
- `errorCode=ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT` adds matching counts alongside total counts.

An error code must contain at most 96 letters, numbers, or underscores and start with a letter.
The match is case-sensitive and literal. It matches `error_code` exactly.
It also matches a substring of `error`, `result_json.errorMessage`, or `result_json.error`.
Other result fields, transcripts, logs, issue data, and run bodies never enter the response.
Error-code groups contain code-shaped values only. Other values become `other`.
Missing error codes use a null group. Unknown statuses become `other`.

The response contains `companyId`, query parameters, `total`, `matchingTotal`, and `rows`.
Each row contains `bucket`, `group`, `count`, and `matchingCount`.
Matching counts are null when no error filter is present.
An empty result contains zero totals and an empty row list.
Clients can sum rows without a second request for the denominator.

The service caches each exact bucket window for 60 seconds.
Each key includes the company, grouping, filter, and exact partial-hour boundaries.
Counts can remain stale during that interval, including historical run status changes.
Concurrent identical requests share one query. The cache holds at most 4096 buckets and 20000 rows.
The query uses the existing `(company_id, created_at DESC)` index range.
The service permits six uncached queries per company per minute and one active query per company.
It permits four active queries globally. Admission tracking holds at most 128 companies per minute.
A rejected query returns HTTP 429. A five-second database timeout returns HTTP 503.
More than 10000 groups returns HTTP 422, without partial totals.
These limits and caches apply per server process.

Example acceptance query:

```text
/api/companies/COMPANY_ID/run-stats?from=2026-10-24T11:36:54Z&to=2026-10-25T11:55:20.654Z&bucket=hour&groupBy=status&errorCode=ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT
```

The historical acceptance report records 2043 runs and zero lock timeouts.
Its query has no upper bound. Its document creation time is only an approximate upper bound.
Use a fixed `to` for a repeatable comparison. Record any boundary difference against that report.
The report also matches a human-readable timeout phrase. This route matches the supplied code only.
Production comparison requires deployment and a board-issued permission grant.
