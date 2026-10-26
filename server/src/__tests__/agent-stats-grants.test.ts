import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  activityLog, agents, companies, companyMemberships, createDb, principalPermissionGrants,
} from "@paperclipai/db";
import { grantAgentStatsReadSchema } from "@paperclipai/shared/run-stats";
import { runStatsRoutes } from "../routes/run-stats.js";
import * as activity from "../services/activity-log.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Agent statistics grant tests skipped: ${support.reason}`);

describe("agent statistics grant contract", () => {
  it("accepts only the statistics permission with no other fields", () => {
    expect(grantAgentStatsReadSchema.safeParse({ permissionKey: "stats:read" }).success).toBe(true);
    for (const body of [{}, { permissionKey: "tasks:assign" }, { permissionKey: "stats:read", scope: {} },
      { permissionKey: "stats:read", membershipRole: "owner" }, { permissionKey: "stats:read", enabled: false }]) {
      expect(grantAgentStatsReadSchema.safeParse(body).success).toBe(false);
    }
  });
});

(support.supported ? describe : describe.skip)("board agent statistics grants", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  const targetId = randomUUID();
  const ceoId = randomUUID();
  const outsiderId = randomUUID();
  const missingMembershipId = randomUUID();
  const statsBody = { permissionKey: "stats:read" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-stats-grants-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Grant tests", issuePrefix: "GRANT" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values([targetId, ceoId, outsiderId, missingMembershipId].map((id) => ({
      id, companyId: id === outsiderId ? otherCompanyId : companyId,
      name: "Synthetic agent", role: id === ceoId ? "ceo" : "engineer", adapterType: "codex_local",
    })));
    await db.insert(companyMemberships).values([
      ...[ownerId, adminId, viewerId].map((id) => ({
        companyId, principalType: "user", principalId: id, status: "active",
        membershipRole: id === ownerId ? "owner" : id === adminId ? "admin" : "viewer",
      })),
      ...[targetId, ceoId, outsiderId].map((id) => ({
        companyId: id === outsiderId ? otherCompanyId : companyId,
        principalType: "agent", principalId: id, status: "active", membershipRole: "member",
      })),
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: ownerId, permissionKey: "users:manage_permissions" },
      { companyId, principalType: "agent", principalId: ceoId, permissionKey: "users:manage_permissions" },
      { companyId, principalType: "agent", principalId: targetId, permissionKey: "tasks:assign_scope",
        scope: { projectIds: [randomUUID()] }, grantedByUserId: ownerId },
      { companyId, principalType: "agent", principalId: targetId, permissionKey: "skills:create", scope: null },
    ]);
  }, 60_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  function app(actor = "owner") {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor === "none" ? { type: "none" }
        : ["owner", "admin", "viewer", "outside-board", "local", "instance-admin"].includes(actor) ? {
          type: "board", userId: actor === "admin" ? adminId : actor === "viewer" ? viewerId : ownerId,
          source: actor === "local" ? "local_implicit" : "session",
          isInstanceAdmin: actor === "instance-admin",
          companyIds: actor === "outside-board" ? [otherCompanyId] : [companyId],
          memberships: [{ companyId, status: "active", membershipRole: actor === "viewer" ? "viewer" : "owner" }],
        } : { type: "agent", agentId: actor, companyId: actor === outsiderId ? otherCompanyId : companyId };
      next();
    });
    instance.use("/api", runStatsRoutes(db));
    const onError: ErrorRequestHandler = (err, _req, res, _next) => {
      res.status(err instanceof ZodError ? 400 : err.status ?? 500).json({ error: err.message });
    };
    instance.use(onError);
    return instance;
  }

  function grant(actor = "owner", agent = targetId, company = companyId, body: unknown = statsBody) {
    return request(app(actor)).post(`/api/companies/${company}/agents/${agent}/permission-grants`).send(body);
  }

  async function snapshot() {
    return {
      grants: await db.select().from(principalPermissionGrants).orderBy(principalPermissionGrants.id),
      memberships: await db.select().from(companyMemberships).orderBy(companyMemberships.id),
      activity: await db.select().from(activityLog).orderBy(activityLog.id),
    };
  }

  it("rejects agents, executives, self grants, and unauthorized board callers without any mutation", async () => {
    const before = await snapshot();
    for (const actor of [targetId, ceoId, outsiderId, "none", "outside-board", "admin", "viewer"]) {
      expect((await grant(actor)).status).toBe(403);
    }
    expect((await grant(ceoId, ceoId)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects other-company targets, absent agents, human targets, and missing memberships", async () => {
    const before = await snapshot();
    expect((await grant("owner", outsiderId)).status).toBe(404);
    expect((await grant("owner", targetId, otherCompanyId)).status).toBe(403);
    expect((await grant("owner", randomUUID())).status).toBe(404);
    expect((await grant("owner", ownerId)).status).toBe(404);
    expect((await grant("owner", missingMembershipId)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects extra fields and other permissions without any mutation", async () => {
    const before = await snapshot();
    for (const body of [{}, { permissionKey: "tasks:assign" }, { ...statsBody, scope: {} },
      { ...statsBody, status: "active" }, { ...statsBody, grants: [] }]) {
      expect((await grant("owner", targetId, companyId, body)).status).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("grants statistics access and preserves every existing scoped grant and membership field", async () => {
    const before = await snapshot();
    const statsPath = `/api/companies/${companyId}/run-stats?from=2026-10-26T00:00:00Z&to=2026-10-26T01:00:00Z`;
    expect((await request(app(targetId)).get(statsPath)).status).toBe(403);
    const response = await grant();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ companyId, agentId: targetId, permissionKey: "stats:read", created: true });
    const after = await snapshot();
    expect(after.memberships).toEqual(before.memberships);
    expect(after.grants.filter((row) => row.permissionKey !== "stats:read")).toEqual(before.grants);
    expect(after.grants.filter((row) => row.permissionKey === "stats:read")).toEqual([
      expect.objectContaining({ companyId, principalType: "agent", principalId: targetId,
        permissionKey: "stats:read", scope: null, grantedByUserId: ownerId }),
    ]);
    expect(after.activity).toEqual([expect.objectContaining({ companyId, actorType: "user", actorId: ownerId,
      action: "agent.stats_read_granted", entityType: "agent", entityId: targetId,
      details: expect.objectContaining({ permissionKey: "stats:read" }) })]);
    expect((await request(app(targetId)).get(statsPath)).status).toBe(200);
  });

  it("leaves repeated requests unchanged and retains an existing statistics scope", async () => {
    await db.update(principalPermissionGrants).set({ scope: { reserved: "preserve" } }).where(and(
      eq(principalPermissionGrants.principalId, targetId), eq(principalPermissionGrants.permissionKey, "stats:read"),
    ));
    const before = await snapshot();
    for (const actor of ["owner", "local", "instance-admin"]) {
      const response = await grant(actor);
      expect(response.status).toBe(200);
      expect(response.body.created).toBe(false);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("creates only one grant and activity entry for concurrent requests without reactivating a suspended member", async () => {
    await db.update(companyMemberships).set({ status: "suspended", membershipRole: "custom-role" })
      .where(eq(companyMemberships.principalId, ceoId));
    const before = await snapshot();
    const responses = await Promise.all([grant("owner", ceoId), grant("owner", ceoId), grant("owner", ceoId)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses.filter((response) => response.body.created)).toHaveLength(1);
    const after = await snapshot();
    expect(after.memberships).toEqual(before.memberships);
    expect(after.grants).toHaveLength(before.grants.length + 1);
    expect(after.activity).toHaveLength(before.activity.length + 1);
    expect((await request(app(ceoId)).get(
      `/api/companies/${companyId}/run-stats?from=2026-10-26T00:00:00Z&to=2026-10-26T01:00:00Z`,
    )).status).toBe(403);
  });

  it("rolls back the grant if activity persistence fails", async () => {
    await db.insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: missingMembershipId, status: "active", membershipRole: "member",
    });
    const before = await snapshot();
    const spy = vi.spyOn(activity, "persistActivity").mockRejectedValueOnce(new Error("Synthetic activity failure"));
    try {
      expect((await grant("owner", missingMembershipId)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });
});
