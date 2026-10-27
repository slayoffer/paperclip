import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
(support.supported ? describe : describe.skip)("outbox backoff migration", () => {
  it("replays safely and gives existing rows an immediately due default", async () => {
    const database = await startEmbeddedPostgresTestDatabase("outbox-backoff-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    const migration = await readFile(new URL("./migrations/0313_last_meteorite.sql", import.meta.url), "utf8");
    const statements = migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    // Simulate the pre-migration shape and a saved row before applying the additions.
    await sql`CREATE TEMP TABLE interaction_resolution_outbox (interaction_id text)`;
    await sql`CREATE TEMP TABLE issue_question_response_deliveries (interaction_id text)`;
    await sql`INSERT INTO interaction_resolution_outbox VALUES ('saved')`;
    await sql`INSERT INTO issue_question_response_deliveries VALUES ('saved')`;
    for (const statement of statements) await sql.unsafe(statement);
    for (const statement of statements) await sql.unsafe(statement);
    for (const table of ["interaction_resolution_outbox", "issue_question_response_deliveries"]) {
      const [row] = await sql`SELECT hold_count, next_attempt_at FROM ${sql(table)} WHERE interaction_id = 'saved'`;
      expect(row).toEqual({ hold_count: 0, next_attempt_at: null });
    }
    const [resolution] = await sql`SELECT failed_at, last_error_code FROM interaction_resolution_outbox`;
    expect(resolution).toEqual({ failed_at: null, last_error_code: null });
  }, 120_000);
});
