import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const companyId = "00000000-0000-0000-0000-000000000001";
const agentId = "00000000-0000-0000-0000-000000000002";
const issueId = "00000000-0000-0000-0000-000000000003";
const indexes = [
  ["heartbeat_runs_company_issue_coalesce_idx", "coalesce(native_issue_id::text, context_snapshot->>'issueId')", true],
  ["heartbeat_runs_company_recovery_action_idx", "context_snapshot->>'recoveryActionId'", true],
  ["heartbeat_runs_company_issue_task_coalesce_idx", "coalesce(context_snapshot->>'issueId', context_snapshot->>'taskId', native_issue_id::text)", false],
] as const;
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describePostgres("heartbeat issue lookup indexes", () => {
  it("migrates existing rows and indexes all three expressions with their distinct precedence", async () => {
    const database = await startEmbeddedPostgresTestDatabase("heartbeat-issue-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    // A fresh database must contain all three indexes before the upgrade test.
    for (const [name] of indexes) {
      expect((await sql`SELECT indexname FROM pg_indexes WHERE indexname = ${name}`)[0]?.indexname).toBe(name);
      await sql.unsafe(`DROP INDEX ${name}`);
    }
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Index test', 'IDX')`;
    await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Index test')`;
    await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      SELECT ${companyId}::uuid, ${agentId}::uuid, 'failed',
        jsonb_build_object('issueId', 'unrelated-' || n, 'recoveryActionId', 'recovery-' || n,
          'padding', repeat(md5(n::text), 100))
      FROM generate_series(1, 16377) AS n`;
    // Conflicting identities prove that the two coalesce expressions are not interchangeable.
    await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, native_issue_id, context_snapshot)
      VALUES (${companyId}, ${agentId}, 'failed', ${issueId},
        jsonb_build_object('issueId', 'snapshot-issue', 'taskId', 'snapshot-task', 'recoveryActionId', ${issueId}::text)),
        (${companyId}, ${agentId}, 'failed', null, jsonb_build_object('issueId', ${issueId}::text)),
        (${companyId}, ${agentId}, 'failed', null, jsonb_build_object('taskId', ${issueId}::text)),
        (${companyId}, ${agentId}, 'failed', ${issueId}, null)`;
    const migration = await readFile(new URL("./migrations/0340_curly_squirrel_girl.sql", import.meta.url), "utf8");
    const statements = migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean);
    // Repeat the real transactional migration to prove restore idempotency.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sql.begin(async tx => {
        for (const statement of statements) await tx.unsafe(statement);
      });
    }
    await sql.unsafe("ANALYZE heartbeat_runs");
    await sql.unsafe("SET plan_cache_mode = force_generic_plan");
    const expectedCounts = [3, 1, 3];
    for (const [i, [name, expression, ordered]] of indexes.entries()) {
      const query = `SELECT id FROM heartbeat_runs WHERE company_id = $1 AND (${expression}) = $2${ordered ? " ORDER BY created_at DESC" : ""}`;
      await sql.unsafe(`PREPARE lookup_${i}(uuid, text) AS ${query}`);
      const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE lookup_${i}('${companyId}', '${issueId}')`);
      const result = plan[0]?.["QUERY PLAN"][0];
      expect(JSON.stringify(result.Plan)).toContain(name);
      expect(JSON.stringify(result.Plan)).not.toContain('"Seq Scan"');
      expect(await sql.unsafe(`EXECUTE lookup_${i}('${companyId}', '${issueId}')`)).toHaveLength(expectedCounts[i]!);
      expect(await sql.unsafe(`EXECUTE lookup_${i}('00000000-0000-0000-0000-000000000099', '${issueId}')`)).toHaveLength(0);
      console.info(JSON.stringify({ index: name, plan: result }));
    }
  }, 240_000);
});
