import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueLabels,
  issueRecoveryActions, issues, labels,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { createHeartbeatPullQueue } from "../services/pull-queue.js";
import { issueOwnerParkingReason, OWNER_PARKING_LABELS, OWNER_PARKING_SKIP_REASON } from "../services/issue-owner-parking.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("owner parking execution authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-parking-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  const companyIds: string[] = [];
  afterEach(async () => {
    await db.update(issues).set({ status: "cancelled" }).where(inArray(issues.companyId, companyIds.splice(0)));
    vi.unstubAllEnvs();
  });

  async function fixture(label: string, status = "todo") {
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    companyIds.push(companyId);
    await db.insert(companies).values({ id: companyId, name: "Parked owner", issuePrefix: `P${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Local session owns this work",
      status, assigneeAgentId: agentId, responsibleUserId: "fixture-owner" }).returning();
    const [tag] = await db.insert(labels).values({ companyId, name: label, color: "#000000" }).returning();
    await db.insert(issueLabels).values({ companyId, issueId, labelId: tag.id });
    return { companyId, agentId, issueId, issue, labelId: tag.id };
  }
  async function run(f: Awaited<ReturnType<typeof fixture>>, status: string) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", runtimeMode: "legacy", status, contextSnapshot: { issueId: f.issueId },
      scheduledRetryReason: status === "scheduled_retry" ? "max_turns_continuation" : null,
      scheduledRetryAt: status === "scheduled_retry" ? new Date(Date.now() - 1000) : null,
      scheduledRetryAttempt: status === "scheduled_retry" ? 1 : 0,
      finishedAt: status === "succeeded" ? new Date(Date.now() - 30_000) : null }).returning();
    return row;
  }

  describe.each([...OWNER_PARKING_LABELS, "Owner:Stopped", "OWNER:LOCAL-SESSION"])("%s", label => {
    it.each(["issue_disposition_repair", "issue_assignment_recovery", "issue_status_changed", "issue_assigned"])(
      "records an admission skip for %s without starting a run", async reason => {
        const f = await fixture(label);
        expect(await heartbeatService(db).wakeup(f.agentId, { source: "automation", triggerDetail: "system",
          reason, requestedByActorType: "user", payload: { issueId: f.issueId },
          contextSnapshot: { issueId: f.issueId } })).toBeNull();
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual([]);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
          .toEqual([expect.objectContaining({ reason: OWNER_PARKING_SKIP_REASON, status: "skipped" })]);
        expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("todo");
      },
    );

    it("skips direct disposition repair and repeated stranded recovery before creating recovery actions", async () => {
      const f = await fixture(label);
      const previous = await run(f, "succeeded");
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      for (let tick = 0; tick < 2; tick += 1) {
        expect(await recovery.reconcileLegacyContinuation(previous.id)).toBe("skipped");
        await recovery.reconcileStrandedAssignedIssues();
      }
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual([]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    });

    it("preserves an existing recovery action without another attempt", async () => {
      const f = await fixture(label, "in_progress");
      await run(f, "failed");
      const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
        sourceIssueId: f.issueId, kind: "execution_recovery", ownerAgentId: f.agentId,
        cause: "execution_failed", fingerprint: randomUUID(), nextAction: "Resume owner",
        wakePolicy: { type: "bounded_recovery_owner" }, attemptCount: 1, maxAttempts: 2 }).returning();
      const enqueueWakeup = vi.fn(async () => null);
      await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
      expect(enqueueWakeup).not.toHaveBeenCalled();
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId)))
        .toEqual([action]);
    });

    it("selects ready work behind a parked queue head and resumes selection after label removal", async () => {
      vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
      const f = await fixture(label);
      const [ready] = await db.insert(issues).values({ companyId: f.companyId, title: "Ready", status: "todo",
        assigneeAgentId: f.agentId, priority: "low" }).returning();
      const wakeup = vi.fn(async () => ({ id: randomUUID() }));
      const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed: false }) });
      try {
        await queue.notify(f.companyId);
        expect(wakeup).toHaveBeenCalledExactlyOnceWith(f.agentId,
          expect.objectContaining({ payload: expect.objectContaining({ issueId: ready.id }) }));
        await db.delete(issueLabels).where(eq(issueLabels.issueId, f.issueId));
        await queue.notify(f.companyId);
        expect(wakeup.mock.calls[1]).toEqual([f.agentId,
          expect.objectContaining({ payload: expect.objectContaining({ issueId: f.issueId }) })]);
      } finally { await queue.stop(); }
    });

    it("rechecks a racing admission stop after label removal", async () => {
      vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
      const f = await fixture("unrelated");
      const wakeup = vi.fn<Parameters<typeof createHeartbeatPullQueue>[1]["wakeup"]>(async () => ({ id: randomUUID() }));
      wakeup.mockImplementationOnce(async (agentId, options) => {
        await db.update(labels).set({ name: label }).where(eq(labels.id, f.labelId));
        return heartbeatService(db).wakeup(agentId, options);
      });
      const queue = createHeartbeatPullQueue(db, { wakeup, isSuppressed: async () => ({ suppressed: false }) });
      try {
        await queue.notify(f.companyId);
        expect(wakeup).toHaveBeenCalledOnce();
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
          .toEqual([expect.objectContaining({ status: "skipped", reason: OWNER_PARKING_SKIP_REASON })]);
        await db.delete(issueLabels).where(eq(issueLabels.issueId, f.issueId));
        await queue.notify(f.companyId);
        expect(wakeup).toHaveBeenCalledTimes(2);
      } finally { await queue.stop(); }
    });

    it("cancels due retry promotion after the owner becomes parked", async () => {
      const f = await fixture("unrelated", "in_progress");
      const pending = await run(f, "scheduled_retry");
      await db.update(labels).set({ name: label }).where(eq(labels.id, f.labelId));
      await db.update(issues).set({ executionRunId: pending.id }).where(eq(issues.id, f.issueId));
      const outcome = await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry({
        companyId: f.companyId, runId: pending.id, now: new Date(),
      });
      expect(outcome).toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_owner_parked" });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, pending.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "issue_owner_parked" });
    });

    it.each(["queued", "running"] as const)("cancels a %s run before provider dispatch", async status => {
      const f = await fixture("unrelated", "in_progress");
      const pending = await run(f, status);
      await db.update(labels).set({ name: label }).where(eq(labels.id, f.labelId));
      await db.update(issues).set({ executionRunId: pending.id }).where(eq(issues.id, f.issueId));
      const adapter = createPostgresRunDispatchAdapter(db);
      const input = { companyId: f.companyId, runId: pending.id, expectedStatus: status, now: new Date() };
      if (status === "queued") {
        expect(await adapter.cancelStaleQueuedRun(input))
          .toMatchObject({ outcome: "cancelled", errorCode: "issue_owner_parked" });
      } else {
        const dispatch = vi.fn(async () => undefined);
        expect(await adapter.dispatchResolvedInteractionIfCurrent({ ...input, dispatch }))
          .toMatchObject({ dispatched: false, cancellation: { errorCode: "issue_owner_parked" } });
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, pending.id)))[0].status).toBe("cancelled");
    });
  });

  it("ignores labels and label associations from another company", async () => {
    const f = await fixture("unrelated");
    const other = await fixture("owner:stopped");
    await db.insert(issueLabels).values({ companyId: other.companyId, issueId: f.issueId, labelId: other.labelId });
    expect(await issueOwnerParkingReason(db, f.issue, "test")).toBeNull();
    await db.update(issueLabels).set({ companyId: f.companyId }).where(eq(issueLabels.issueId, f.issueId));
    expect(await issueOwnerParkingReason(db, f.issue, "test")).toBeNull();
  });
});
