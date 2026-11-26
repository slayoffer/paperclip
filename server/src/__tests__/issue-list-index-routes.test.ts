import { randomUUID } from "node:crypto";
import { activityLog, createDb, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
} from "./helpers/route-test-harness.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type IndexRow = {
  id: string;
  identifier: string;
  listProjection: string;
  updatedAt: string;
  lastActivityAt: string;
};

const openStatusFilter = "todo,in_progress,in_review,blocked,backlog";
const fixtureStatuses = ["todo", "in_progress", "in_review", "blocked", "backlog"];

describeEmbeddedPostgres("read-only issue index", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let readDb: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-index-");
    db = createDb(database.connectionString);
    const readUrl = new URL(database.connectionString);
    readUrl.searchParams.set("default_transaction_read_only", "on");
    readDb = createDb(readUrl.toString());
    expect(await readDb.execute(sql`show transaction_read_only`))
      .toMatchObject([{ transaction_read_only: "on" }]);
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  it("walks two full 500-row pages and an empty page with exact legacy ID parity", async () => {
    const company = await seedCompanyWithBoardAccess(db, "Index pagination");
    const foreign = await seedCompanyWithBoardAccess(db, "Other company");
    const ids = Array.from({ length: 1000 }, () => randomUUID());
    await db.insert(issues).values([
      ...ids.map((id, index) => ({
        id,
        companyId: company.companyId,
        identifier: `IDX-${index + 1}`,
        title: `Indexed issue ${index + 1}`,
        status: fixtureStatuses[index % fixtureStatuses.length],
      })),
      { companyId: company.companyId, title: "Closed issue", status: "done" },
      { companyId: foreign.companyId, title: "Foreign issue", status: "todo" },
    ]);

    const client = request(routeApp(readDb, company.actor, issueRoutes));
    const path = `/api/companies/${company.companyId}/issues`;
    const filters = { status: openStatusFilter, sortField: "id", sortDir: "asc" };
    const rows: IndexRow[] = [];
    const pageSizes: number[] = [];
    for (let page = 0; page < 3; page += 1) {
      const afterId = rows.at(-1)?.id;
      const response = await client.get(path).query({
        ...filters, view: "index", limit: 500, ...(afterId ? { afterId } : {}),
      }).expect(200);
      expect(Array.isArray(response.body)).toBe(true);
      pageSizes.push(response.body.length);
      rows.push(...response.body);
    }

    expect(pageSizes).toEqual([500, 500, 0]);
    expect(rows.every((row) => row.listProjection === "index")).toBe(true);
    const indexIds = rows.map((row) => row.id);
    expect(new Set(indexIds).size).toBe(1000);
    expect(indexIds).toEqual(ids.sort());
    const legacy = await client.get(path).query({ ...filters, limit: 1000 }).expect(200);
    expect(JSON.stringify(indexIds)).toBe(JSON.stringify(legacy.body.map((row: IndexRow) => row.id)));
  });

  it("matches legacy activity markers after issue, comment, and card activity", async () => {
    const company = await seedCompanyWithBoardAccess(db, "Index activity");
    const id = randomUUID();
    const initial = new Date("2026-10-01T00:00:00Z");
    const updated = new Date("2026-10-02T00:00:00Z");
    const commented = new Date("2026-10-03T00:00:00Z");
    const answered = new Date("2026-10-04T00:00:00Z");
    await db.insert(issues).values({
      id, companyId: company.companyId, identifier: "ACT-1",
      title: "Issue activity", status: "todo", createdAt: initial, updatedAt: initial,
    });
    const client = request(routeApp(readDb, company.actor, issueRoutes));
    const path = `/api/companies/${company.companyId}/issues`;
    async function expectMarkers(updatedAt: Date, lastActivityAt: Date) {
      const legacy = await client.get(path).expect(200);
      const index = await client.get(path).query({ view: "index" }).expect(200);
      expect(index.body).toHaveLength(1);
      expect(index.body[0]).toMatchObject({
        id, listProjection: "index", updatedAt: updatedAt.toISOString(),
        lastActivityAt: lastActivityAt.toISOString(),
      });
      expect(legacy.body).toHaveLength(1);
      expect(index.body[0]).toMatchObject({
        updatedAt: legacy.body[0].updatedAt, lastActivityAt: legacy.body[0].lastActivityAt,
      });
    }

    await expectMarkers(initial, initial);
    await db.update(issues).set({ updatedAt: updated }).where(eq(issues.id, id));
    await expectMarkers(updated, updated);
    await db.insert(issueComments).values({
      companyId: company.companyId, issueId: id, body: "New reply", createdAt: commented,
    });
    await expectMarkers(updated, commented);
    await db.insert(activityLog).values({
      companyId: company.companyId, entityId: id, entityType: "issue",
      action: "issue.thread_interaction_answered", actorId: company.userId, createdAt: answered,
    });
    await expectMarkers(updated, answered);
  });

  it("only queries PostgreSQL for an issue with a stale active recovery action", async () => {
    const company = await seedCompanyWithBoardAccess(db, "Index recovery");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId: company.companyId, title: "Closed source", status: "done",
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: company.companyId, sourceIssueId: issueId, kind: "manual",
      cause: "fixture", fingerprint: "fixture", nextAction: "Check the source",
    }).returning();
    const client = request(routeApp(readDb, company.actor, issueRoutes));
    const statements: string[] = [];
    const previousDebug = readDb.$client.options.debug;
    readDb.$client.options.debug = (_connection, query) => { statements.push(query); };
    try {
      const response = await client.get(`/api/companies/${company.companyId}/issues`)
        .query({ view: "index", status: "done" }).expect(200);
      expect(response.body).toMatchObject([{ id: issueId, listProjection: "index" }]);
    } finally {
      readDb.$client.options.debug = previousDebug;
    }

    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((query) => !/^\s*(select|with)\b/i.test(query))).toEqual([]);
    expect(statements.filter((query) => query.includes('"issue_recovery_actions"'))).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))
      .toEqual([action]);
  });
});
