import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { runStatsQuerySchema } from "@paperclipai/shared/run-stats";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared/constants";
import { runStatsRoutes } from "../routes/run-stats.js";
import { runStatsService } from "../services/run-stats.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST } from "../../../packages/adapter-utils/src/sandbox-callback-bridge-routes.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Run statistics database tests skipped: ${support.reason}`);
const errorCode = "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT";
const historical = runStatsQuerySchema.parse({
  from: "2026-10-24T11:36:54Z", to: "2026-10-25T11:55:20.654Z", errorCode,
});
const recent = { ...historical, from: "2026-10-26T00:00:00Z", to: "2026-10-26T01:00:00Z" };

describe("run statistics contract", () => {
  it("rejects unsafe and excessive query shapes", () => {
    for (const change of [
      { from: "2026-10-01T00:00:00Z" }, { to: historical.from },
      { from: "invalid" }, { to: "2026-10-23T00:00:00Z" },
      { bucket: "minute" }, { groupBy: "error" }, { errorCode: "%_" },
      { errorCode: [errorCode, "other"] }, { from: "2026-10-24T11:36:54" }, { limit: "1" },
    ]) expect(runStatsQuerySchema.safeParse({ ...historical, ...change }).success).toBe(false);
    expect(runStatsQuerySchema.safeParse({ ...historical, to: "2026-11-07T11:36:54Z" }).success).toBe(true);
  });

  it("permits only read access through the callback bridge", () => {
    const path = `/api/companies/${randomUUID()}/run-stats`;
    const allows = (method: string, target = path) => DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST
      .some((rule) => rule.method === method && rule.path.test(target));
    expect(allows("GET")).toBe(true);
    for (const method of ["POST", "PATCH", "DELETE"]) expect(allows(method)).toBe(false);
    expect(allows("GET", `${path}/raw`)).toBe(false);
  });

  it("maps a database timeout to a bounded response and releases query admission", async () => {
    const transaction = vi.fn().mockRejectedValueOnce({ cause: { code: "57014" } }).mockRejectedValueOnce({ code: "57014" });
    const stats = runStatsService({ transaction } as unknown as Db);
    await expect(stats.report("company", historical)).rejects.toMatchObject({ status: 503 });
    await expect(stats.report("company", historical)).rejects.toMatchObject({ status: 503 });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("enforces the same group limit for cached and fresh results", async () => {
    const rows = (bucket: string) => Array.from({ length: 6000 }, (_, index) => ({
      bucket, group: `CODE_${index}`, count: 1, matchingCount: 0,
    }));
    const first = rows("2026-10-26T00:00:00.000Z");
    const second = rows("2026-10-26T01:00:00.000Z");
    const transaction = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce([...first, ...second]);
    const stats = runStatsService({ transaction } as unknown as Db);
    await stats.report("company", recent);
    await stats.report("company", { ...recent, from: recent.to, to: "2026-10-26T02:00:00Z" });
    await expect(stats.report("company", { ...recent, to: "2026-10-26T02:00:00Z" })).rejects.toMatchObject({ status: 422 });
    expect(transaction).toHaveBeenCalledTimes(2);
    const fresh = runStatsService({ transaction } as unknown as Db);
    await expect(fresh.report("company", { ...recent, to: "2026-10-26T02:00:00Z" })).rejects.toMatchObject({ status: 422 });
  });
});

(support.supported ? describe : describe.skip)("run statistics database and route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let base: string;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const ownerId = randomUUID();
  const ordinaryId = randomUUID();
  const suspendedId = randomUUID();
  const outsiderId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-stats-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Statistics", issuePrefix: "STATS" },
      { id: otherCompanyId, name: "Private company", issuePrefix: "PRIVATE" },
    ]);
    await db.insert(agents).values([ownerId, ordinaryId, suspendedId, outsiderId].map((id) => ({
      id, companyId: id === outsiderId ? otherCompanyId : companyId,
      name: "Owner title gives no permission", role: "engineer", adapterType: "codex_local",
    })));
    await db.insert(companyMemberships).values([ownerId, ordinaryId, suspendedId].map((id) => ({
      companyId, principalType: "agent", principalId: id,
      status: id === suspendedId ? "suspended" : "active", membershipRole: "member",
    })));
    await db.insert(principalPermissionGrants).values([ownerId, suspendedId].map((id) => ({
      companyId, principalType: "agent", principalId: id, permissionKey: "stats:read",
    })));
    // Recreate the report denominator without treating quoted transcripts as failures.
    for (let offset = 0; offset < 2043; offset += 500) {
      await db.insert(heartbeatRuns).values(Array.from({ length: Math.min(500, 2043 - offset) }, (_, i) => {
        const index = offset + i;
        return { companyId, agentId: ownerId, createdAt: new Date("2026-10-24T12:00:00Z"),
          status: index < 1824 ? "succeeded" : index < 1903 ? "failed" : index < 2016 ? "cancelled" : "running",
          resultJson: { stdout: errorCode },
        };
      }));
    }
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: ownerId, errorCode },
      { companyId, agentId: ownerId, error: `prefix ${errorCode} suffix` },
      { companyId, agentId: ownerId, resultJson: { errorMessage: errorCode } },
      { companyId, agentId: ordinaryId, resultJson: { error: errorCode } },
      { companyId, agentId: ownerId, resultJson: { stdout: errorCode }, errorCode: "private error text" },
      { companyId: otherCompanyId, agentId: outsiderId, errorCode },
    ].map((run) => ({ ...run, createdAt: new Date(recent.from), status: "failed", stdoutExcerpt: "private output" })));
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: ownerId, createdAt: new Date("2026-10-24T11:36:53.999Z") },
      { companyId, agentId: ownerId, createdAt: new Date(historical.to) },
    ]);
    await db.insert(heartbeatRuns).values([...HEARTBEAT_RUN_STATUSES, "private status text"].map((status) => ({
      companyId, agentId: ownerId, status, createdAt: new Date("2026-10-28T00:00:00Z"),
    })));
    const app = express();
    app.use((req, _res, next) => {
      const actor = req.header("x-actor") ?? "board";
      req.actor = actor === "none" ? { type: "none" }
        : actor === "board" ? { type: "board", source: "session", companyIds: [companyId] }
        : { type: "agent", agentId: actor, companyId: actor === outsiderId ? otherCompanyId : companyId };
      next();
    });
    app.use("/api", runStatsRoutes(db));
    const onError: ErrorRequestHandler = (err, _req, res, _next) => {
      res.status(err instanceof ZodError ? 400 : err.status ?? 500).json({ error: err.message });
    };
    app.use(onError);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no address");
    base = `http://127.0.0.1:${address.port}/api/companies`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await tempDb?.cleanup();
  });

  function request(query = historical, actor = ownerId, company = companyId) {
    return fetch(`${base}/${company}/run-stats?${new URLSearchParams(Object.entries(query))}`, {
      headers: { "x-actor": actor },
    });
  }

  it("refuses ungranted, suspended, anonymous, and cross-company principals before statistics queries", async () => {
    const transaction = vi.spyOn(db, "transaction");
    for (const actor of [ordinaryId, suspendedId, outsiderId, "none"]) {
      expect((await request(historical, actor)).status).toBe(actor === "none" ? 401 : 403);
    }
    expect((await request(historical, ownerId, otherCompanyId)).status).toBe(403);
    expect((await request(historical, "board", otherCompanyId)).status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it("returns the 2043-run denominator and zero matches to the granted owner and board", async () => {
    for (const actor of [ownerId, "board"]) {
      const response = await request(historical, actor);
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report.total).toBe(2043);
      expect(report.matchingTotal).toBe(0);
      expect(report.rows.map((row: { count: number }) => row.count).sort((a: number, b: number) => a - b))
        .toEqual([27, 79, 113, 1824]);
      for (const row of report.rows) expect(Object.keys(row).sort()).toEqual(["bucket", "count", "group", "matchingCount"]);
      expect(JSON.stringify(report)).not.toMatch(/stdout|resultJson|private output|contextSnapshot/);
    }
  });

  it("matches only explicit error fields and returns all supported groupings", async () => {
    for (const groupBy of ["status", "errorCode", "agentId"] as const) {
      const response = await request({ ...recent, groupBy });
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report.total).toBe(5);
      expect(report.matchingTotal).toBe(4);
      expect(JSON.stringify(report)).not.toContain("private error text");
      expect(JSON.stringify(report)).not.toContain(outsiderId);
    }
  });

  it("preserves every supported status and suppresses unknown status text", async () => {
    const report = await runStatsService(db).report(companyId, {
      ...historical, from: "2026-10-28T00:00:00Z", to: "2026-10-28T01:00:00Z",
    });
    expect(report.rows.map((row) => row.group).sort()).toEqual([...HEARTBEAT_RUN_STATUSES, "other"].sort());
  });

  it("returns empty results and rejects invalid ranges", async () => {
    const response = await request({ ...recent, from: "2026-10-27T00:00:00Z", to: "2026-10-27T01:00:00Z" });
    expect(await response.json()).toMatchObject({ total: 0, matchingTotal: 0, rows: [] });
    expect((await request({ ...recent, to: recent.from })).status).toBe(400);
  });

  it("rechecks permission before a cached response", async () => {
    expect((await request()).status).toBe(200);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, ownerId));
    try {
      expect((await request()).status).toBe(403);
    } finally {
      await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, ownerId));
    }
  });

  it("caches buckets, shares concurrent queries, expires counts, and limits uncached queries", async () => {
    let clock = 0;
    const stats = runStatsService(db, () => clock);
    const transaction = vi.spyOn(db, "transaction");
    const [one, two] = await Promise.all([stats.report(companyId, historical), stats.report(companyId, historical)]);
    expect(one).toEqual(two);
    expect(transaction).toHaveBeenCalledTimes(1);
    const partial = await stats.report(companyId, { ...historical, to: "2026-10-24T12:00:00Z" });
    expect(partial.total).toBe(0);
    expect(transaction).toHaveBeenCalledTimes(1);
    // A subrange reuses the same complete bucket without another database call.
    await stats.report(companyId, { ...historical, from: "2026-10-24T12:00:00Z", to: "2026-10-24T13:00:00Z" });
    expect(transaction).toHaveBeenCalledTimes(1);
    clock = 60_001;
    await stats.report(companyId, historical);
    expect(transaction).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) await stats.report(companyId, { ...recent, errorCode: `CODE_${i}` });
    await expect(stats.report(companyId, { ...recent, errorCode: "NEW_CODE" })).rejects.toMatchObject({ status: 429 });
    transaction.mockRestore();
  });
});
