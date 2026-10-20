import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, createDb, heartbeatRuns, issues, publicationAuthorityClocks, publicationBrokers, publicationRequests,
} from "@paperclipai/db";
import { publicationReconciliationService } from "./publication-authority-reconciliation.js";
import { authorityFixture, barrier, startAuthorityDatabase, waitForDatabaseWait } from "./publication-authority.test-fixture.js";

describe("protected reconciliation preserves single use without old broker authority", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  beforeAll(async () => { storage = await startAuthorityDatabase(); }, 90_000);
  afterAll(async () => { await storage?.database.cleanup(); });
  const fixture = () => authorityFixture(storage.db);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const proof = () => ({ result: "succeeded" as const, evidenceId: randomUUID() });
  const reconciler = (f: Fixture, verify = vi.fn(async () => proof())) => publicationReconciliationService(storage.db, {
    companyId: f.identity.companyId, verifierId: "synthetic-protected-verifier", verify,
  });
  async function dispatch(f: Fixture) {
    await f.service.request(f.identity, f.bindings);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
  }

  it.each(["certificate expiry", "broker revocation", "issuer revocation"] as const)(
    "recovers after %s without restoring the original broker", async (mode) => {
      const f = await fixture();
      await dispatch(f);
      await f.service.recordResult(f.identity, f.bindings, "unknown");
      if (mode === "certificate expiry") f.advance(100_001);
      else await storage.db.update(publicationBrokers).set(mode === "broker revocation"
        ? { revokedAt: new Date() } : { issuerRevoked: true }).where(eq(publicationBrokers.id, f.identity.brokerId));
      const [oldBroker] = await storage.db.select().from(publicationBrokers).where(eq(publicationBrokers.id, f.identity.brokerId));
      const identity = { ...f.identity, brokerId: randomUUID(), certificateId: randomUUID() };
      const now = await f.clock();
      await storage.db.insert(publicationBrokers).values({
        id: identity.brokerId, companyId: identity.companyId, certificateId: identity.certificateId,
        issuerId: identity.issuerId, validFromMs: now.wallMs, validUntilMs: now.wallMs + 100_000,
      });
      const next = { ...f.next(), brokerId: identity.brokerId };
      expect(await f.service.request(identity, next)).toMatchObject({ reason: "recorded" });
      expect(await f.service.dispatch(identity, next)).toMatchObject({ reason: "reconciliation_required" });
      const evidence = proof(), verify = vi.fn(async () => evidence);
      const restarted = publicationReconciliationService(createDb(storage.database.connectionString), {
        companyId: identity.companyId, verifierId: "synthetic-protected-verifier", verify,
      });
      expect(await restarted.reconcile(f.bindings)).toMatchObject({ dispatch: false, reason: "reconciled", state: "succeeded" });
      expect(verify).toHaveBeenCalledExactlyOnceWith(f.bindings);
      expect(await f.service.recordResult(f.identity, f.bindings, "succeeded")).toMatchObject({ reason: "authority_unavailable" });
      expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
      expect((await f.service.dispatch(identity, next)).dispatch).toBe(true);
      expect(await storage.db.select().from(publicationBrokers).where(eq(publicationBrokers.id, f.identity.brokerId)))
        .toEqual([oldBroker]);
      const logs = await storage.db.select().from(activityLog).where(and(
        eq(activityLog.entityId, f.bindings.requestId), eq(activityLog.action, "publication.reconciled"),
      ));
      expect(logs).toMatchObject([{
        companyId: identity.companyId, actorType: "system", actorId: "synthetic-protected-verifier",
        agentId: f.identity.agentId, runId: f.identity.runId, details: { reconciliationId: evidence.evidenceId },
      }]);
    },
  );

  it("reconciles unreported results after assignment, run, and clock authority end", async () => {
    const f = await fixture();
    await dispatch(f);
    await storage.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.bindings.issueId));
    await storage.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.identity.runId));
    await storage.db.update(publicationAuthorityClocks).set({ uncertain: true }).where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
    expect(await reconciler(f).reconcile(f.bindings)).toMatchObject({ reason: "reconciled", dispatch: false });
    expect((await f.service.dispatch(f.identity, f.next())).dispatch).toBe(false);
  });

  it("checks company scope and every immutable binding before verification", async () => {
    const f = await fixture(), other = await fixture();
    await dispatch(f);
    const verify = vi.fn(async () => proof());
    const service = reconciler(f, verify);
    expect(await reconciler(other, verify).reconcile(f.bindings)).toMatchObject({ reason: "authority_unavailable" });
    for (const key of ["companyId", "requestId", "brokerId", "agentId", "runId", "issueId"] as const) {
      expect(await service.reconcile({ ...f.bindings, [key]: randomUUID() })).toMatchObject({ reason: "authority_unavailable" });
    }
    for (const patch of [{ commitSha: "c".repeat(40) }, { expectedOldSha: "d".repeat(40) },
      { repository: "synthetic/other" }, { branch: "review/OTHER-1" }]) {
      expect(await service.reconcile({ ...f.bindings, ...patch })).toMatchObject({ reason: "authority_unavailable" });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await service.reconcile(f.bindings)).toMatchObject({ reason: "reconciled" });
  });

  it("retains the barrier when verification fails or evidence is invalid", async () => {
    const f = await fixture();
    await dispatch(f);
    const next = f.next();
    await f.service.request(f.identity, next);
    const service = publicationReconciliationService(storage.db, {
      companyId: f.identity.companyId, verifierId: "synthetic-protected-verifier",
      verify: async () => { throw new Error("synthetic verifier failure"); },
    });
    await expect(service.reconcile(f.bindings)).rejects.toThrow("synthetic verifier failure");
    expect(await publicationReconciliationService(storage.db, {
      companyId: f.identity.companyId, verifierId: "synthetic-protected-verifier",
      verify: async () => ({ result: "refused", evidenceId: "invalid" }),
    }).reconcile(f.bindings)).toMatchObject({ reason: "result_uncertain" });
    expect(await f.service.dispatch(f.identity, next)).toMatchObject({ reason: "reconciliation_required" });
  });

  it("rechecks state after observation and preserves the first audit and evidence", async () => {
    const f = await fixture();
    await dispatch(f);
    const observed = barrier(), release = barrier();
    const late = publicationReconciliationService(storage.db, {
      companyId: f.identity.companyId, verifierId: "synthetic-late-verifier",
      verify: async () => { observed.release(); await release.ready; return proof(); },
    }).reconcile(f.bindings);
    await observed.ready;
    const evidence = proof();
    try { expect(await reconciler(f, vi.fn(async () => evidence)).reconcile(f.bindings)).toMatchObject({ reason: "reconciled" }); }
    finally { release.release(); }
    expect(await late).toMatchObject({ reason: "replay" });
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    expect(row!.reconciliationId).toBe(evidence.evidenceId);
    expect(await storage.db.select().from(activityLog).where(and(eq(activityLog.entityId, row!.id),
      eq(activityLog.action, "publication.reconciled")))).toHaveLength(1);
  });

  it("waits for request writers and rolls back a result with its failed audit", async () => {
    const f = await fixture();
    await dispatch(f);
    const locked = barrier(), release = barrier();
    let pid = 0;
    const writer = storage.db.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      pid = row!.pid;
      await tx.update(publicationRequests).set({ state: "unknown" }).where(eq(publicationRequests.id, f.bindings.requestId));
      locked.release(); await release.ready;
    });
    await locked.ready;
    const result = reconciler(f).reconcile(f.bindings);
    try { await waitForDatabaseWait(storage.db, pid); }
    finally { release.release(); await writer; }
    expect(await result).toMatchObject({ reason: "reconciled" });

    const next = { ...f, bindings: f.next() };
    await dispatch(next);
    await storage.db.execute(sql`create function synthetic_reconciliation_audit_failure() returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit failure'; end $$`);
    await storage.db.execute(sql`create trigger synthetic_reconciliation_audit_failure before insert on activity_log
      for each row execute function synthetic_reconciliation_audit_failure()`);
    try { await expect(reconciler(next).reconcile(next.bindings)).rejects.toThrow(); }
    finally {
      await storage.db.execute(sql`drop trigger synthetic_reconciliation_audit_failure on activity_log`);
      await storage.db.execute(sql`drop function synthetic_reconciliation_audit_failure()`);
    }
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, next.bindings.requestId));
    expect(row).toMatchObject({ state: "dispatched", reconciliationId: null });
    expect(await reconciler(next).reconcile(next.bindings)).toMatchObject({ reason: "reconciled" });
  });

  it.each(["dispatched", "unknown"] as const)("prevents deletion and recreation after %s", async (state) => {
    const f = await fixture();
    await dispatch(f);
    if (state === "unknown") await f.service.recordResult(f.identity, f.bindings, "unknown");
    await expect(storage.db.delete(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId)))
      .rejects.toThrow();
    await expect(storage.db.execute(sql`truncate table publication_requests`)).rejects.toThrow();
    const restarted = await import("./publication-authority.js").then(({ publicationAuthorityService }) =>
      publicationAuthorityService(createDb(storage.database.connectionString), { clock: f.clock }));
    expect(await restarted.request(f.identity, f.bindings)).toMatchObject({ reason: "replay", state });
    expect((await restarted.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
    const next = f.next();
    await restarted.request(f.identity, next);
    expect(await restarted.dispatch(f.identity, next)).toMatchObject({ reason: "reconciliation_required" });
    expect(await reconciler(f).reconcile(f.bindings)).toMatchObject({ reason: "reconciled" });
    await expect(storage.db.delete(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId))).rejects.toThrow();
    expect((await restarted.dispatch(f.identity, next)).dispatch).toBe(true);
  });
});
