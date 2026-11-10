import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("resolution provenance migration", () => {
  it("migrates legacy resolved and pending rows without backfill and preserves unknown attribution", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-resolution-migration-");
    const db = createDb(temporary.connectionString);
    try {
      const migration = await readFile(new URL(
        "../../../packages/db/src/migrations/0383_hot_enchantress.sql", import.meta.url,
      ), "utf8");
      const hash = createHash("sha256").update(migration).digest("hex");
      // Recreate the pre-migration schema only in this disposable database.
      await db.$client.unsafe("DROP TRIGGER issue_thread_interactions_preserve_resolved_via ON issue_thread_interactions");
      await db.$client.unsafe("DROP FUNCTION preserve_interaction_resolved_via()");
      await db.$client.unsafe("ALTER TABLE issue_thread_interactions DROP COLUMN resolved_via CASCADE, DROP COLUMN resolved_via_key_id CASCADE");
      await db.$client`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      const companyId = randomUUID();
      const issueId = randomUUID();
      const resolvedId = randomUUID();
      const pendingId = randomUUID();
      await db.$client`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Legacy', 'LEG')`;
      await db.$client`INSERT INTO issues (id, company_id, title) VALUES (${issueId}, ${companyId}, 'Legacy')`;
      await db.$client`INSERT INTO issue_thread_interactions
        (id, company_id, issue_id, kind, status, payload, resolved_at, resolved_by_user_id)
        VALUES (${resolvedId}, ${companyId}, ${issueId}, 'request_confirmation', 'accepted',
          '{"version":1,"prompt":"Continue?"}'::jsonb, now(), 'legacy-user'),
        (${pendingId}, ${companyId}, ${issueId}, 'request_confirmation', 'pending',
          '{"version":1,"prompt":"Continue?"}'::jsonb, NULL, NULL)`;
      await applyPendingMigrations(temporary.connectionString);
      const rows = await db.$client`SELECT id, resolved_via, resolved_via_key_id, resolved_by_user_id
        FROM issue_thread_interactions WHERE company_id = ${companyId}`;
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === resolvedId)).toMatchObject({
        resolved_via: null, resolved_via_key_id: null, resolved_by_user_id: "legacy-user",
      });
      expect(rows.find((row) => row.id === pendingId)).toMatchObject({ resolved_via: null, resolved_via_key_id: null });
      await expect(db.$client`UPDATE issue_thread_interactions SET resolved_via = 'user_session'
        WHERE id = ${resolvedId}`).rejects.toMatchObject({ code: "P0001" });
      await db.$client`UPDATE issue_thread_interactions SET resolved_at = now(), resolved_via = 'system'
        WHERE id = ${pendingId}`;
      const [saved] = await db.$client`SELECT resolved_via, resolved_via_key_id FROM issue_thread_interactions
        WHERE id = ${pendingId}`;
      expect(saved).toMatchObject({ resolved_via: "system", resolved_via_key_id: null });
      await applyPendingMigrations(temporary.connectionString);
    } finally { await db.$client.end(); await temporary.cleanup(); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
