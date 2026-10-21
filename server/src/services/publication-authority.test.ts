import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issues, projectWorkspaces,
  publicationAuthorityClocks, publicationBrokers, publicationRequests,
} from "@paperclipai/db";
import { publicationDispatchWithinDeadline, type PublicationBindings, type PublicationDecision } from "@paperclipai/shared";
import { publicationAuthorityService } from "./publication-authority.js";
import { publicationReconciliationService } from "./publication-authority-reconciliation.js";
import { authorityFixture, startAuthorityDatabase } from "./publication-authority.test-fixture.js";

describe("offline publication authority with durable PostgreSQL records", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  beforeAll(async () => { storage = await startAuthorityDatabase(); }, 90_000);
  afterAll(async () => { await storage?.database.cleanup(); });
  const fixture = () => authorityFixture(storage.db);

  it("records bindings once and enforces database immutability", async () => {
    const f = await fixture();
    expect(await f.service.request(f.identity, f.bindings)).toMatchObject({ dispatch: false, state: "pending" });
    f.advance(100);
    expect(await f.service.request(f.identity, f.bindings, 100)).toMatchObject({ dispatch: false, reason: "replay" });
    expect(await f.service.request(f.identity, { ...f.bindings, commitSha: "c".repeat(40) })).toMatchObject({ reason: "bindings_changed" });
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    expect(row!.expiresAtMs - row!.issuedAtMs).toBe(30_000);
    await expect(storage.db.update(publicationRequests).set({ bindings: { ...f.bindings, commitSha: "d".repeat(40) } })
      .where(eq(publicationRequests.id, f.bindings.requestId))).rejects.toThrow();
    await expect(storage.db.update(publicationRequests).set({ expiresAtMs: row!.expiresAtMs + 1 })
      .where(eq(publicationRequests.id, f.bindings.requestId))).rejects.toThrow();
  });

  it("records concurrent creation once and never resets a dispatched request", async () => {
    const f = await fixture();
    const records = await Promise.all(Array.from({ length: 4 }, () => f.service.request(f.identity, f.bindings)));
    expect(records.filter((r) => r.reason === "recorded")).toHaveLength(1);
    await f.service.dispatch(f.identity, f.bindings);
    await f.service.recordResult(f.identity, f.bindings, "succeeded");
    await expect(storage.db.update(publicationRequests).set({ state: "pending", dispatchedAtMs: null })
      .where(eq(publicationRequests.id, f.bindings.requestId))).rejects.toThrow();
  });

  it("isolates complete identities and requests between companies", async () => {
    const f = await fixture(), other = await fixture();
    await f.service.request(f.identity, f.bindings);
    const b = { ...f.bindings, companyId: other.identity.companyId, brokerId: other.identity.brokerId,
      agentId: other.identity.agentId, runId: other.identity.runId };
    expect((await other.service.dispatch(other.identity, b)).dispatch).toBe(false);
    expect((await other.service.revoke(other.identity, b)).dispatch).toBe(false);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
    await other.service.request(other.identity, other.bindings);
    expect((await other.service.dispatch(other.identity, other.bindings)).dispatch).toBe(true);
  });

  it("permits only one dispatch across concurrent calls and a lost-response restart", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.service.dispatch(f.identity, f.bindings)));
    expect(results.filter((result) => result.dispatch)).toHaveLength(1);
    const freshDb = createDb(storage.database.connectionString);
    const restarted = publicationAuthorityService(freshDb, { clock: f.clock });
    expect(await restarted.dispatch(f.identity, f.bindings)).toMatchObject({ dispatch: false, state: "dispatched" });
    expect(await restarted.request(f.identity, f.bindings)).toMatchObject({ dispatch: false, state: "dispatched" });
    const logs = await storage.db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.bindings.requestId), eq(activityLog.action, "publication.dispatched"),
    ));
    expect(logs).toHaveLength(1);
  });

  it("rejects every altered binding and identity", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    for (const key of ["companyId", "brokerId", "agentId", "runId", "issueId", "requestId"] as const) {
      expect((await f.service.dispatch(f.identity, { ...f.bindings, [key]: randomUUID() })).dispatch).toBe(false);
    }
    for (const patch of [
      { repository: "synthetic/other" }, { branch: "review/TEST-2" },
      { commitSha: "c".repeat(40) }, { expectedOldSha: "d".repeat(40) },
      { operation: "create_pull_request", expectedOldSha: undefined, sourceRepository: "synthetic/authority", sourceBranch: "review/TEST-1", headSha: "a".repeat(40) },
    ]) {
      const candidate = { ...f.bindings, ...patch };
      if (candidate.operation !== "push") delete candidate.expectedOldSha;
      expect((await f.service.dispatch(f.identity, candidate)).dispatch).toBe(false);
    }
    for (const key of ["companyId", "brokerId", "agentId", "runId", "issuerId", "certificateId"] as const) {
      expect((await f.service.dispatch({ ...f.identity, [key]: randomUUID() }, f.bindings)).dispatch).toBe(false);
    }
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
  });

  it.each([0, -1, 30_001, 0.5, NaN, Infinity])("rejects invalid lifetime %s", async (lifetime) => {
    const f = await fixture();
    expect(await f.service.request(f.identity, f.bindings, lifetime)).toMatchObject({ reason: "invalid_lifetime" });
  });

  it("uses authority time and denies expiry at the exact deadline", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings, 500);
    f.advance(499);
    expect(await f.service.dispatch(f.identity, f.bindings)).toMatchObject({ dispatch: true, remainingLifetimeMs: 1 });
    await f.service.recordResult(f.identity, f.bindings, "refused");
    const next = f.next();
    await f.service.request(f.identity, next, 500);
    f.advance(500);
    expect(await f.service.dispatch(f.identity, next)).toMatchObject({ dispatch: false, reason: "expired" });
  });

  it("uses the earlier certificate expiry and rechecks it on a current connection", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    await storage.db.update(publicationBrokers).set({ validUntilMs: (await f.clock()).wallMs + 200 })
      .where(eq(publicationBrokers.id, f.identity.brokerId));
    expect(await f.service.dispatch(f.identity, f.bindings)).toMatchObject({ dispatch: true, remainingLifetimeMs: 200 });
    await f.service.recordResult(f.identity, f.bindings, "refused");
    const next = f.next();
    await f.service.request(f.identity, next);
    f.advance(200);
    expect((await f.service.dispatch(f.identity, next)).dispatch).toBe(false);
  });

  it("latches authority clock rollback across a service restart", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    f.advance(-1);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    f.advance(100);
    const restarted = publicationAuthorityService(storage.db, { clock: f.clock });
    expect((await restarted.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    const [state] = await storage.db.select().from(publicationAuthorityClocks).where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
    expect(state!.uncertain).toBe(true);
  });

  it("does not extend lifetime when the wall clock loses elapsed time between observations", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    f.advance(100);
    f.advanceMonotonic(30_000);
    expect(await f.service.dispatch(f.identity, f.bindings)).toMatchObject({ dispatch: false, reason: "expired" });
  });

  it("denies a changed clock epoch and a lost monotonic reference", async () => {
    for (const mode of ["epoch", "rollback"] as const) {
      const f = await fixture();
      await f.service.request(f.identity, f.bindings);
      const service = publicationAuthorityService(storage.db, { clock: async () => {
        const time = await f.clock();
        return mode === "epoch" ? { ...time, epoch: "restarted-clock" } : { ...time, monotonicMs: time.monotonicMs - 1 };
      } });
      expect((await service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    }
  });

  it("blocks fresh requests after an unknown result until protected reconciliation", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings);
    await f.service.dispatch(f.identity, f.bindings);
    await f.service.recordResult(f.identity, f.bindings, "unknown");
    const next = f.next();
    await f.service.request(f.identity, next);
    expect(await f.service.dispatch(f.identity, next)).toMatchObject({ reason: "reconciliation_required" });
    expect(await f.service.recordResult(f.identity, f.bindings, "refused")).toMatchObject({ state: "unknown" });
    expect(await publicationReconciliationService(storage.db, {
      companyId: f.identity.companyId, verifierId: randomUUID(),
    }).reconcile(f.bindings)).toMatchObject({ reason: "verifier_unavailable" });
    const evidenceId = randomUUID();
    let result: "unknown" | "succeeded" = "unknown";
    const restarted = publicationReconciliationService(createDb(storage.database.connectionString), {
      companyId: f.identity.companyId, verifierId: randomUUID(), verify: async () => ({ result, evidenceId }),
    });
    expect(await restarted.reconcile(f.bindings)).toMatchObject({ reason: "result_uncertain" });
    expect((await f.service.dispatch(f.identity, next)).dispatch).toBe(false);
    result = "succeeded";
    expect(await restarted.reconcile(f.bindings)).toMatchObject({ state: "succeeded", dispatch: false });
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    expect((await f.service.dispatch(f.identity, next)).dispatch).toBe(true);
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    expect(row!.reconciliationId).toBe(evidenceId);
  });

  it("keeps outstanding dispatches blocked after expiry and revocation", async () => {
    const f = await fixture();
    await f.service.request(f.identity, f.bindings, 1);
    await f.service.dispatch(f.identity, f.bindings);
    f.advance(2);
    await f.service.revoke(f.identity, f.bindings);
    const next = f.next();
    await f.service.request(f.identity, next);
    expect(await f.service.dispatch(f.identity, next)).toMatchObject({ reason: "reconciliation_required" });
  });

  it("refuses missing authority records and uncertain time", async () => {
    for (const mode of ["clock", "broker", "request", "uncertain"] as const) {
      const f = await fixture();
      if (mode !== "request") await f.service.request(f.identity, f.bindings);
      if (mode === "clock") await storage.db.delete(publicationAuthorityClocks).where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
      if (mode === "broker") await storage.db.update(publicationBrokers).set({ issuerRevoked: true }).where(eq(publicationBrokers.id, f.identity.brokerId));
      const service = mode === "uncertain" ? publicationAuthorityService(storage.db, { clock: async () => null }) : f.service;
      expect((await service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    }
  });

  it("denies changed current authority through every locked record", async () => {
    const mutations = [
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.bindings.issueId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.bindings.issueId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.bindings.issueId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.identity.runId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.identity.agentId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.identity.companyId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(projectWorkspaces).set({ repoUrl: "https://github.com/synthetic/other" }).where(eq(projectWorkspaces.id, f.workspaceId)),
      async (f: Awaited<ReturnType<typeof fixture>>) => storage.db.update(publicationBrokers).set({ revokedAt: new Date() }).where(eq(publicationBrokers.id, f.identity.brokerId)),
    ];
    for (const mutate of mutations) {
      const f = await fixture();
      await f.service.request(f.identity, f.bindings);
      await mutate(f);
      expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    }
  });

  it.each(["create_pull_request", "update_pull_request"] as const)("binds %s source and number", async (operation) => {
    const f = await fixture();
    const { expectedOldSha: _, ...common } = f.bindings;
    const b: PublicationBindings = {
      ...common, operation, sourceRepository: common.repository, sourceBranch: common.branch, headSha: common.commitSha,
      ...(operation === "update_pull_request" ? { pullRequestNumber: 42 } : {}),
    } as PublicationBindings;
    await f.service.request(f.identity, b);
    for (const patch of [{ sourceRepository: "synthetic/other" }, { sourceBranch: "review/TEST-2" }, { headSha: "e".repeat(40) }]) {
      expect((await f.service.dispatch(f.identity, { ...b, ...patch })).dispatch).toBe(false);
    }
    if (operation === "update_pull_request") expect((await f.service.dispatch(f.identity, { ...b, pullRequestNumber: 43 })).dispatch).toBe(false);
    expect((await f.service.dispatch(f.identity, b)).dispatch).toBe(true);
  });

  it("rejects extra credential fields without storing them in audit records", async () => {
    const f = await fixture();
    const sentinel = "synthetic-secret-sentinel";
    await expect(f.service.request(f.identity, { ...f.bindings, credential: sentinel })).rejects.toThrow();
    const logs = await storage.db.select().from(activityLog).where(eq(activityLog.companyId, f.identity.companyId));
    expect(JSON.stringify(logs)).not.toContain(sentinel);
  });
});

describe("broker monotonic dispatch boundary", () => {
  const decision: PublicationDecision = { dispatch: true, state: "dispatched", reason: "authorized", remainingLifetimeMs: 30_000 };
  it("counts response delay and preparation from request start", () => {
    expect(publicationDispatchWithinDeadline(decision, 10, 1009)).toBe(true);
    expect(publicationDispatchWithinDeadline(decision, 10, 1010)).toBe(false);
    expect(publicationDispatchWithinDeadline({ ...decision, remainingLifetimeMs: 200 }, 10, 210)).toBe(false);
    for (const end of [9, Infinity, NaN]) expect(publicationDispatchWithinDeadline(decision, 10, end)).toBe(false);
    expect(publicationDispatchWithinDeadline({ ...decision, dispatch: false }, 10, 11)).toBe(false);
  });
});
