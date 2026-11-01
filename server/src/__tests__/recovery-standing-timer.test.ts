import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueRecoveryActions, issues,
} from "@paperclipai/db";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService, type RecoveryWakeup } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("standing timer continuation recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("standing-timer-");
    db = createDb(temporary.connectionString);
  }, 20_000);
  afterEach(async () => { await db.update(issues).set({ status: "done" }); });
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function fixture(options: {
    reference?: "id" | "identifier";
    enabled?: boolean;
    intervalSec?: number;
    status?: string;
    unassigned?: boolean;
    otherAgent?: boolean;
    otherDriver?: boolean;
    succeeded?: boolean;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const identifier = `T${companyId.slice(0, 6)}-1`;
    const otherDriverId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Timer recovery", issuePrefix: identifier.slice(0, -2), defaultResponsibleUserId: "fixture-owner" });
    const peerId = randomUUID();
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Driver", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: {
          enabled: options.enabled ?? true, intervalSec: options.intervalSec ?? 900, wakeOnDemand: true,
          driverIssueId: options.otherDriver ? otherDriverId : options.reference === "id" ? issueId : ` ${identifier.toLowerCase()} `,
        } } },
      { id: peerId, companyId, name: "Peer", role: "engineer", status: "idle", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { wakeOnDemand: true } } },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, identifier, title: "Standing driver", status: options.status ?? "in_progress",
      assigneeAgentId: options.unassigned ? null : options.otherAgent ? peerId : agentId, responsibleUserId: "fixture-owner",
    });
    if (options.otherDriver) await db.insert(issues).values({
      id: otherDriverId, companyId, title: "Other driver", status: "backlog", assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "timer", runtimeMode: "legacy",
      status: options.succeeded ? "succeeded" : "cancelled",
      errorCode: options.succeeded ? null : "issue_continuation_waiting_on_review",
      contextSnapshot: { issueId, timerDriverIssue: true }, livenessState: "blocked",
      finishedAt: new Date(), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const enqueueWakeup = vi.fn<RecoveryWakeup>(async (targetAgentId, opts) => db.transaction(async tx => {
      const [wake] = await tx.insert(agentWakeupRequests).values({
        companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason,
        payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued",
      }).returning();
      const [run] = await tx.insert(heartbeatRuns).values({
        companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued",
        runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot,
      }).returning();
      await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
      return run;
    }));
    const recovery = recoveryService(db, { enqueueWakeup });
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const readIssue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    return { companyId, agentId, issueId, runId, recovery, enqueueWakeup, actions, readIssue };
  }

  it.each(["id", "identifier"] as const)("accepts the timer's %s reference without a deadline or repair", async reference => {
    const f = await fixture({ reference, succeeded: true });
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("covered");
    const result = await f.recovery.reconcileStrandedAssignedIssues();
    expect(result.failed).toBe(0);
    expect(result.dispositionRepairRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(await f.actions()).toEqual([]);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await f.readIssue()).toMatchObject({ status: "in_progress", unblockDescriptor: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
  });

  it("does not repair a cancelled deliberate wait when the timer owns continuation", async () => {
    const f = await fixture();
    const result = await f.recovery.reconcileStrandedAssignedIssues();
    expect(result.failed).toBe(0);
    expect(await f.actions()).toEqual([]);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await f.readIssue()).toMatchObject({ status: "in_progress", unblockDescriptor: null });
  });

  it.each(["agent", "board"] as const)("resolves an existing %s action on the next pass without reopening", async ownerType => {
    const f = await fixture();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "deliberate_wait_without_target",
      ownerType, ownerAgentId: ownerType === "agent" ? f.agentId : null,
      returnOwnerAgentId: f.agentId, cause: "deliberate_wait_without_target", fingerprint: "exhausted",
      evidence: { terminalReason: "unchanged_source_state_exhausted" }, nextAction: "Choose a disposition.",
      attemptCount: 5, maxAttempts: 5,
    });
    for (let pass = 0; pass < 2; pass += 1) {
      expect((await f.recovery.reconcileStrandedAssignedIssues()).failed).toBe(0);
      expect(await f.actions()).toEqual([expect.objectContaining({
        id: action.id, status: "resolved", outcome: "restored", resolutionNote: "standing_driver_timer_continuation",
      })]);
    }
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
    expect(await f.readIssue()).toMatchObject({ status: "in_progress", unblockDescriptor: null });
  });

  it.each([
    { name: "disabled timer", enabled: false },
    { name: "zero interval", intervalSec: 0 },
    { name: "another driver", otherDriver: true },
    { name: "another assignee", otherAgent: true },
  ])("keeps deliberate-wait repair for $name", async options => {
    const f = await fixture(options);
    expect((await f.recovery.reconcileStrandedAssignedIssues()).failed).toBe(0);
    expect(await f.actions()).toEqual([expect.objectContaining({ kind: "deliberate_wait_without_target", status: "active" })]);
    expect(f.enqueueWakeup).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "unassigned", unassigned: true },
    ...["todo", "blocked", "in_review", "backlog", "done", "cancelled"].map(status => ({ name: status, status })),
  ])("keeps existing action resolution rules for $name", async options => {
    const f = await fixture(options);
    await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "deliberate_wait_without_target",
      ownerType: "board", returnOwnerAgentId: f.agentId, cause: "deliberate_wait_without_target",
      fingerprint: "existing", nextAction: "Choose a disposition.",
    });
    expect((await f.recovery.reconcileStrandedAssignedIssues()).failed).toBe(0);
    const terminal = "status" in options && ["done", "cancelled"].includes(options.status!);
    expect(await f.actions()).toEqual([expect.objectContaining({
      status: terminal ? "resolved" : "active", resolutionNote: terminal ? "source_terminal" : null,
    })]);
    expect(f.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("blocks a delayed legacy repair after the standing timer becomes enabled", async () => {
    const f = await fixture({ enabled: false, succeeded: true });
    expect(await f.recovery.reconcileLegacyContinuation(f.runId)).toBe("queued");
    const first = f.enqueueWakeup.mock.results[0];
    const repair = await first.value;
    expect(repair).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, repair!.id));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, repair!.wakeupRequestId!));
    expect(await f.recovery.reconcileLegacyContinuation(repair!.id)).toBe("queued");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const delayed = runs.find(run => run.status === "scheduled_retry")!;
    expect(await f.recovery.legacyRepairDispatchBlock(delayed.id)).toBeNull();
    await db.update(agents).set({ runtimeConfig: { heartbeat: {
      enabled: true, intervalSec: 900, driverIssueId: f.issueId,
    } } }).where(eq(agents.id, f.agentId));
    expect(await f.recovery.legacyRepairDispatchBlock(delayed.id)).toBe("durable_wait");
    expect((await f.recovery.reconcileStrandedAssignedIssues()).failed).toBe(0);
    expect(await f.actions()).toEqual([expect.objectContaining({
      status: "resolved", resolutionNote: "standing_driver_timer_continuation",
    })]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(3);
  });

  it("does not resolve another kind of recovery action", async () => {
    const f = await fixture();
    await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "missing_disposition",
      ownerType: "board", cause: "successful_run_missing_issue_disposition",
      fingerprint: "other-kind", nextAction: "Inspect the run.",
    });
    expect((await f.recovery.reconcileStrandedAssignedIssues()).failed).toBe(0);
    expect(await f.actions()).toEqual([expect.objectContaining({
      kind: "missing_disposition", status: "active", resolutionNote: null,
    })]);
  });
});
