import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { RunStatsCount, RunStatsQuery, RunStatsReport } from "@paperclipai/shared/run-stats";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared/constants";
import { HttpError, tooManyRequests, unprocessable } from "../errors.js";

const HOUR = 60 * 60 * 1000;
const CACHE_MS = 60_000;
const MAX_CACHE_BUCKETS = 4096;
const MAX_CACHE_ROWS = 20_000;
const MAX_GROUPS = 10_000;

export function runStatsService(db: Db, now = Date.now) {
  const cache = new Map<string, { expires: number; rows: RunStatsCount[] }>();
  const pending = new Map<string, Promise<RunStatsReport>>();
  const admission = new Map<string, { until: number; queries: number; active: boolean }>();
  let active = 0;

  async function collect(companyId: string, query: RunStatsQuery): Promise<RunStatsReport> {
    const start = Date.parse(query.from);
    const end = Date.parse(query.to);
    const windows = [];
    for (let at = start; at < end;) {
      const next = Math.min(end, (Math.floor(at / HOUR) + 1) * HOUR);
      const key = JSON.stringify([companyId, at, next, query.groupBy, query.errorCode ?? null]);
      windows.push({ at, next, key });
      at = next;
    }
    for (const [key, entry] of cache) if (entry.expires <= now()) cache.delete(key);
    const collected = new Map(windows.flatMap(({ key }) => {
      const entry = cache.get(key);
      return entry ? [[key, entry.rows] as const] : [];
    }));
    const missing = windows.filter(({ key }) => !cache.has(key));
    if (missing.length) {
      for (const [key, entry] of admission) {
        if (!entry.active && entry.until <= now()) admission.delete(key);
      }
      let gate = admission.get(companyId);
      if (!gate) {
        if (admission.size >= 128) throw tooManyRequests("Run statistics are busy. Retry after 60 seconds.");
        gate = { until: now() + CACHE_MS, queries: 0, active: false };
        admission.set(companyId, gate);
      }
      if (gate.active || gate.queries >= 6 || active >= 4) {
        throw tooManyRequests("Run statistics are busy. Retry after 60 seconds.");
      }
      gate.queries++;
      gate.active = true;
      active++;
      try {
        const bucket = sql<string>`to_char(date_trunc('hour', ${heartbeatRuns.createdAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')`;
        // Do not return free text from status or error_code, including malformed adapter values.
        const group = query.groupBy === "agentId" ? sql<string>`${heartbeatRuns.agentId}::text`
          : query.groupBy === "status" ? sql<string>`case when ${inArray(heartbeatRuns.status, HEARTBEAT_RUN_STATUSES)}
            then ${heartbeatRuns.status} else 'other' end`
          : sql<string | null>`case when ${heartbeatRuns.errorCode} ~ '^[A-Za-z][A-Za-z0-9_]{0,95}$'
            then ${heartbeatRuns.errorCode} when ${heartbeatRuns.errorCode} is null then null else 'other' end`;
        // CASE fixes the order: reading result_json detoasts the whole value (p50 205 KB on 2026-10-31), so it is read
        // last and never for a succeeded run, which carries no error text. Before, 14 days took 34.7 s against the 5 s
        // limit; now 0.47 s (SYNA-3580).
        const matches = query.errorCode ? sql`(case
          when ${heartbeatRuns.errorCode} = ${query.errorCode} then true
          when position(${query.errorCode} in coalesce(${heartbeatRuns.error}, '')) > 0 then true
          when ${heartbeatRuns.status} = 'succeeded' then false
          else position(${query.errorCode} in coalesce(${heartbeatRuns.resultJson}->>'errorMessage', '')) > 0
            or position(${query.errorCode} in coalesce(${heartbeatRuns.resultJson}->>'error', '')) > 0 end)` : sql`false`;
        const rows = await db.transaction(async (tx) => {
          await tx.execute(sql`set local statement_timeout = '5s'`);
          return tx.select({ bucket, group,
            count: sql<number>`count(*)::int`,
            matchingCount: sql<number>`count(*) filter (where ${matches})::int`,
          }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, new Date(missing[0]!.at)),
            lt(heartbeatRuns.createdAt, new Date(missing[missing.length - 1]!.next)),
          )).groupBy(sql`1`, sql`2`).orderBy(sql`1`, sql`2`).limit(MAX_GROUPS + 1);
        }, { accessMode: "read only" });
        if (rows.length > MAX_GROUPS) throw unprocessable("Too many groups. Use a shorter range.");
        for (const window of missing) {
          const bucketStart = Math.floor(window.at / HOUR) * HOUR;
          const bucketRows = rows.filter((row) => Date.parse(row.bucket) === bucketStart)
            .map((row) => ({ ...row, matchingCount: query.errorCode ? row.matchingCount : null }));
          cache.set(window.key, { expires: now() + CACHE_MS, rows: bucketRows });
          collected.set(window.key, bucketRows);
        }
      } catch (error) {
        if ((error as { code?: string }).code === "57014"
          || (error as { cause?: { code?: string } }).cause?.code === "57014") {
          throw new HttpError(503, "Run statistics timed out. Use a shorter range.");
        }
        throw error;
      } finally {
        gate.active = false;
        active--;
      }
    }
    const rows = windows.flatMap(({ key }) => collected.get(key)!);
    // Evict only after assembling this response, which can span many buckets.
    let cachedRows = [...cache.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
    while (cache.size > MAX_CACHE_BUCKETS || cachedRows > MAX_CACHE_ROWS) {
      const oldest = cache.keys().next().value!;
      cachedRows -= cache.get(oldest)!.rows.length;
      cache.delete(oldest);
    }
    if (rows.length > MAX_GROUPS) throw unprocessable("Too many groups. Use a shorter range.");
    return { ...query, companyId, total: rows.reduce((sum, row) => sum + row.count, 0),
      matchingTotal: query.errorCode ? rows.reduce((sum, row) => sum + (row.matchingCount ?? 0), 0) : null, rows };
  }

  return {
    report(companyId: string, query: RunStatsQuery) {
      const key = JSON.stringify([companyId, query]);
      const existing = pending.get(key);
      if (existing) return existing;
      const result = collect(companyId, query).finally(() => pending.delete(key));
      pending.set(key, result);
      return result;
    },
  };
}
