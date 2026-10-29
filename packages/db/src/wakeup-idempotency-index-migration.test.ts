import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const indexName = "agent_wakeup_requests_company_idempotency_idx";
const companyId = "00000000-0000-0000-0000-000000000001";
const agentId = "00000000-0000-0000-0000-000000000002";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describePostgres("wake idempotency lookup index migration", () => {
  it("indexes generic equality and multi-key lookups on an existing table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("wake-idempotency-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // Check the full migration chain, then reproduce an upgrade with existing rows.
    const [initialIndex] = await sql`
      SELECT indexname FROM pg_indexes WHERE indexname = ${indexName}
    `;
    expect(initialIndex?.indexname).toBe(indexName);
    await sql.unsafe(`DROP INDEX ${indexName}`);
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Index test', 'IDX')`;
    await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Index test')`;
    await sql`INSERT INTO companies (id, name, issue_prefix)
      VALUES ('00000000-0000-0000-0000-000000000003', 'Other company', 'OTH')`;
    await sql`INSERT INTO agents (id, company_id, name)
      VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'Other agent')`;
    await sql`INSERT INTO agent_wakeup_requests (company_id, agent_id, source, idempotency_key)
      VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004', 'test', 'unrestricted:2')`;
    await sql`
      INSERT INTO agent_wakeup_requests (company_id, agent_id, source, idempotency_key, status)
      SELECT ${companyId}::uuid, ${agentId}::uuid, 'test', 'unrestricted:' || n,
        CASE WHEN n % 2 = 0 THEN 'queued' ELSE 'failed' END
      FROM generate_series(1, 55500) AS n
    `;
    // General keys can repeat. This index must not impose a new uniqueness rule.
    await sql`
      INSERT INTO agent_wakeup_requests (company_id, agent_id, source, idempotency_key, status)
      VALUES (${companyId}, ${agentId}, 'test', 'unrestricted:2', 'queued')
    `;
    await sql.unsafe("ANALYZE agent_wakeup_requests");
    const before = await sql.unsafe(`EXPLAIN SELECT id FROM agent_wakeup_requests
      WHERE company_id = '${companyId}' AND idempotency_key = 'unrestricted:2'
        AND status NOT IN ('skipped', 'failed', 'cancelled')`);
    expect(before.map((row) => row["QUERY PLAN"]).join("\n")).toContain("Seq Scan");

    const migration = await readFile(new URL("./migrations/0339_shocking_ultron.sql", import.meta.url), "utf8");
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    await sql.begin(async (tx) => { await tx.unsafe(migration); });
    const [definition] = await sql`
      SELECT i.indisunique, i.indpred IS NULL AS unrestricted
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ${indexName}
    `;
    expect(definition).toMatchObject({ indisunique: false, unrestricted: true });

    // A generic prepared plan cannot infer any key-prefix partial predicate.
    await sql.unsafe("SET plan_cache_mode = force_generic_plan");
    await sql.unsafe(`PREPARE wake_one(uuid, text) AS SELECT id FROM agent_wakeup_requests
      WHERE company_id = $1 AND idempotency_key = $2
        AND status NOT IN ('skipped', 'failed', 'cancelled')`);
    await sql.unsafe(`PREPARE wake_many(uuid, text, text, text, text) AS SELECT id FROM agent_wakeup_requests
      WHERE company_id = $1 AND idempotency_key IN ($2, $3, $4, $5)
        AND status NOT IN ('skipped', 'failed', 'cancelled')`);
    for (const execution of [
      `wake_one('${companyId}', 'unrestricted:2')`,
      `wake_many('${companyId}', 'unrestricted:1', 'unrestricted:2', 'unrestricted:4', 'unrestricted:missing')`,
    ]) {
      const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ${execution}`);
      const result = plan[0]?.["QUERY PLAN"][0];
      expect(JSON.stringify(result.Plan)).toContain(indexName);
      expect(JSON.stringify(result.Plan)).not.toContain('"Seq Scan"');
      console.info(JSON.stringify({ execution, plan: result }));
    }
    expect(await sql.unsafe(`EXECUTE wake_one('${companyId}', 'unrestricted:2')`)).toHaveLength(2);
    expect(await sql.unsafe(`EXECUTE wake_many('${companyId}', 'unrestricted:1', 'unrestricted:2', 'unrestricted:4', 'unrestricted:missing')`)).toHaveLength(3);

    const partialIndexes = await sql`
      SELECT count(*)::int AS count FROM pg_indexes
      WHERE tablename = 'agent_wakeup_requests' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
        AND indexdef LIKE '% WHERE %'
    `;
    expect(partialIndexes[0]?.count).toBe(6);
  }, 240_000);
});
