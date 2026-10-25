import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueRelations, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { buildIssueBlockersResolvedWakeStateKey, hasAdmittedDependencyWake } from "../services/issue-dependency-wakeups.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("concurrent dependency wake producers", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("dependency-wake-concurrency-");
    db = createDb(temp.connectionString);
    // Admit durable requests without starting an adapter or changing the fixture.
    startTaskDrain();
  }, 90_000);

  afterAll(async () => {
    await temp?.cleanup();
    stopTaskDrain();
  });

  it("admits one request and one activity entry when finalize races the backstop", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    const blockerId = randomUUID(), dependentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Concurrent wake test",
      issuePrefix: `T${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Cancelled blocker", status: "cancelled" },
      { id: dependentId, companyId, title: "Dependent", status: "blocked",
        assigneeAgentId: agentId, responsibleUserId: "responsible-user" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId,
      relatedIssueId: dependentId, type: "blocks" });

    const heartbeat = heartbeatService(db);
    const otherServer = heartbeatService(createDb(temp.connectionString));
    let arrivals = 0;
    let release!: () => void;
    const bothProducers = new Promise<void>(resolve => { release = resolve; });
    const enqueueWakeup: typeof heartbeat.wakeup = async (id, options) => {
      // Both real producers must pass their optimistic checks before admission.
      if (++arrivals === 2) release();
      await bothProducers;
      return options?.contextSnapshot?.source === "workspace.finalize"
        ? heartbeat.wakeup(id, options) : otherServer.wakeup(id, options);
    };
    const finalize = recoveryService(db, { enqueueWakeup });
    const backstop = recoveryService(db, { enqueueWakeup });
    const results = await Promise.all([
      finalize.reconcileResolvedDependencyWakeBackstop({ companyId, blockerIssueId: blockerId,
        source: "workspace.finalize" }),
      backstop.reconcileResolvedDependencyWakeBackstop({ companyId, blockerIssueId: blockerId }),
    ]);

    expect(arrivals).toBe(2);
    const requests = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.idempotencyKey).toMatch(/:release$/);
    expect(results.reduce((count, result) => count + result.healed, 0)).toBe(1);
    const events = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.entityId, dependentId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);

    const repeated = await backstop.reconcileResolvedDependencyWakeBackstop({ companyId });
    expect(repeated.healed).toBe(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
  }, 30_000);

  it.each(["queued", "deferred_issue_execution", "claimed", "coalesced", "completed",
    "failed", "cancelled", "skipped"])("checks the persisted %s receipt without preventing valid retries", async status => {
    const companyId = randomUUID(), agentId = randomUUID(), dependentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission receipt test",
      issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const state = { dependentIssueId: dependentId, blockerIssueIds: [randomUUID()],
      blockedTransitionAt: new Date("2026-10-25T00:00:00Z") };
    const key = buildIssueBlockersResolvedWakeStateKey(state);
    await db.insert(agentWakeupRequests).values({ companyId, agentId, status,
      source: "automation", reason: "issue_blockers_resolved", idempotencyKey: key + ":release" });
    const covered = ["queued", "deferred_issue_execution", "claimed", "coalesced", "completed"].includes(status);
    expect(await hasAdmittedDependencyWake(db, companyId, key + ":release")).toBe(covered);
    expect(await hasAdmittedDependencyWake(db, companyId, key)).toBe(covered);
    expect(await hasAdmittedDependencyWake(db, randomUUID(), key + ":release")).toBe(false);
    const nextCycle = buildIssueBlockersResolvedWakeStateKey({ ...state,
      blockedTransitionAt: new Date("2026-10-26T00:00:00Z") });
    expect(await hasAdmittedDependencyWake(db, companyId, nextCycle + ":release")).toBe(false);
    expect(await hasAdmittedDependencyWake(db, companyId, "another-wake-key")).toBe(false);

    await db.update(agentWakeupRequests).set({ idempotencyKey: key })
      .where(eq(agentWakeupRequests.companyId, companyId));
    // A completed old wake permits the historical release repair.
    expect(await hasAdmittedDependencyWake(db, companyId, key + ":release"))
      .toBe(covered && status !== "completed");
  });
});
