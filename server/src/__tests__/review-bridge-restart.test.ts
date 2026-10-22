import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, documentRevisions, documents, heartbeatRuns, issueDocuments,
  issueRecoveryActions, issues, agents, getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";
import { heartbeatService } from "../services/heartbeat.js";
import { dispatchBridgeWakes } from "../services/review-bridge-wakes.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("bridge receipt restart recovery", () => {
  const f = bridgeFixture();

  async function deferWake(event: "timeout" | "document", clearLock: boolean) {
    await f.park();
    const [source] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "queued", runtimeMode: "legacy", responsibleUserId: "board",
      contextSnapshot: { issueId: f.issue.id } }).returning();
    await f.db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id,
      responsibleUserId: "board",
      ...(event === "timeout" ? { unblockDescriptor: {
        ...f.wait, until: new Date(Date.now() - 1000).toISOString(),
      } } : {}),
    }).where(eq(issues.id, f.issue.id));
    if (event === "document") {
      const [document] = await f.db.insert(documents).values({ companyId: f.companyId, latestBody: f.eventBody() }).returning();
      await f.db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issue.id,
        documentId: document.id, key: "bridge" });
      await f.db.insert(documentRevisions).values({ companyId: f.companyId, documentId: document.id,
        revisionNumber: 1, body: f.eventBody(), createdByUserId: "board" });
    }
    await dispatchBridgeWakes(f.db, heartbeatService(f.db).wakeup, { companyId: f.companyId });
    const receipts = await f.db.select().from(agentWakeupRequests);
    const receipt = receipts.find(row => row.status === "deferred_issue_execution")!;
    expect(receipt).toBeDefined();
    expect(receipt.payload?.commentId).toBeUndefined();
    expect(receipts.filter(row => row.status === "completed_bridge_dispatch")).toHaveLength(1);

    // Simulate a crash after terminalization and before queue promotion.
    await f.db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, source.id));
    if (clearLock) await f.db.update(issues).set({ executionRunId: null, checkoutRunId: null })
      .where(eq(issues.id, f.issue.id));

    // Occupy the only execution slot. Recovery must queue without starting a provider.
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "1");
    await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", responsibleUserId: "board", contextSnapshot: {} });
    return { source, receipt };
  }

  it.each([
    ["timeout", false], ["timeout", true], ["document", false], ["document", true],
  ] as const)("promotes one %s receipt after restart, cleared lock: %s", async (event, clearLock) => {
    const { source, receipt } = await deferWake(event, clearLock);
    const restarted = heartbeatService(f.db);
    await restarted.resumeQueuedRuns();
    const [saved] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(saved).toMatchObject({ id: receipt.id, status: "queued", idempotencyKey: receipt.idempotencyKey,
      requestedByActorId: receipt.requestedByActorId, runId: expect.any(String) });
    const runs = await f.db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(3);
    expect(runs.find(run => run.id === saved.runId)).toMatchObject({ status: "queued", wakeupRequestId: receipt.id,
      contextSnapshot: { issueId: f.issue.id, wakeReason: event === "timeout" ? "review_bridge_timeout" : "review_bridge_event" } });
    expect(saved.runId).not.toBe(source.id);
    await restarted.resumeQueuedRuns();
    await restarted.reconcileStrandedAssignedIssues();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(3);
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("preserves an execution hold until its resolution", async () => {
    const { receipt } = await deferWake("timeout", false);
    const [hold] = await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", status: "escalated", cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: f.agentId, fingerprint: randomUUID(), nextAction: "Check provider actions." }).returning();
    const restarted = heartbeatService(f.db);
    await restarted.resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await f.db.select().from(agentWakeupRequests)).find(row => row.id === receipt.id)?.status)
      .toBe("deferred_issue_execution");
    expect((await f.db.select().from(issueRecoveryActions))[0].status).toBe("escalated");
    await f.db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, hold.id));
    await restarted.resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(3);
  });

  it("promotes the stable receipt once during concurrent restart sweeps", async () => {
    const { receipt } = await deferWake("document", false);
    await Promise.all([heartbeatService(f.db).resumeQueuedRuns(), heartbeatService(f.db).resumeQueuedRuns()]);
    const [saved] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(saved).toMatchObject({ id: receipt.id, status: "queued", idempotencyKey: receipt.idempotencyKey });
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(3);
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it.each([
    ["timeout", false], ["timeout", true], ["document", false], ["document", true],
  ] as const)("recovers %s after a hold without matching history, lock predecessor: %s", async (event, predecessor) => {
    await f.park();
    await f.db.update(issues).set({ responsibleUserId: "board",
      ...(event === "timeout" ? { unblockDescriptor: {
        ...f.wait, until: new Date(Date.now() - 1000).toISOString(),
      } } : {}),
    }).where(eq(issues.id, f.issue.id));
    if (event === "document") {
      const [document] = await f.db.insert(documents).values({ companyId: f.companyId, latestBody: f.eventBody() }).returning();
      await f.db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issue.id,
        documentId: document.id, key: "bridge" });
      await f.db.insert(documentRevisions).values({ companyId: f.companyId, documentId: document.id,
        revisionNumber: 1, body: f.eventBody(), createdByUserId: "board" });
    }
    const [hold] = await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", status: "escalated", cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: f.agentId, fingerprint: randomUUID(), nextAction: "Check provider actions." }).returning();
    if (predecessor) {
      const [source] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "succeeded", runtimeMode: "legacy", responsibleUserId: "board", contextSnapshot: {},
        startedAt: new Date(), finishedAt: new Date() }).returning();
      await f.db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id })
        .where(eq(issues.id, f.issue.id));
    }
    await dispatchBridgeWakes(f.db, heartbeatService(f.db).wakeup, { companyId: f.companyId });
    const [receipt] = (await f.db.select().from(agentWakeupRequests)).filter(row => row.status === "deferred_issue_execution");
    expect(receipt).toBeDefined();
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "1");
    await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "legacy", responsibleUserId: "board", contextSnapshot: {} });
    const baseline = (await f.db.select().from(heartbeatRuns)).length;
    const restarted = heartbeatService(f.db);
    await restarted.resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(baseline);
    expect((await f.db.select().from(agentWakeupRequests)).find(row => row.id === receipt.id)?.status)
      .toBe("deferred_issue_execution");
    expect((await f.db.select().from(issueRecoveryActions))[0].status).toBe("escalated");
    await f.db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, hold.id));
    await Promise.all([restarted.resumeQueuedRuns(), heartbeatService(f.db).resumeQueuedRuns()]);
    await restarted.resumeQueuedRuns();
    await restarted.reconcileStrandedAssignedIssues();
    const [saved] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(saved).toMatchObject({ id: receipt.id, status: "queued", idempotencyKey: receipt.idempotencyKey,
      requestedByActorId: receipt.requestedByActorId, runId: expect.any(String) });
    const runs = await f.db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(baseline + 1);
    expect(runs.find(run => run.id === saved.runId)).toMatchObject({ status: "queued", wakeupRequestId: receipt.id,
      contextSnapshot: { issueId: f.issue.id, wakeReason: event === "timeout" ? "review_bridge_timeout" : "review_bridge_event" } });
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("retains the receipt behind a live executor without matching context", async () => {
    const { source, receipt } = await deferWake("timeout", false);
    await f.db.update(heartbeatRuns).set({ status: "running", contextSnapshot: {}, finishedAt: null })
      .where(eq(heartbeatRuns.id, source.id));
    await heartbeatService(f.db).resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await f.db.select().from(agentWakeupRequests)).find(row => row.id === receipt.id)?.status)
      .toBe("deferred_issue_execution");
    await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, source.id));
    await heartbeatService(f.db).resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(3);
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("retains the receipt while its agent is paused", async () => {
    const { receipt } = await deferWake("document", true);
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const restarted = heartbeatService(f.db);
    await restarted.resumeQueuedRuns();
    await restarted.resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(2);
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
    expect((await f.db.select().from(agentWakeupRequests)).find(row => row.id === receipt.id)?.status)
      .toBe("deferred_issue_execution");
    await f.db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    await restarted.resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(3);
    expect(await f.db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("cancels a deferred receipt when a new issue version replaces it", async () => {
    const { receipt } = await deferWake("timeout", true);
    await f.db.update(issues).set({ status: "blocked", statusVersion: 3, unblockDescriptor: f.wait })
      .where(eq(issues.id, f.issue.id));
    await heartbeatService(f.db).resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await f.db.select().from(agentWakeupRequests)).find(row => row.id === receipt.id)?.status).toBe("cancelled");
    expect((await f.current()).status).toBe("blocked");
  });

  it("does not promote a receipt without its matching dispatch identity", async () => {
    const { receipt } = await deferWake("timeout", true);
    await f.db.update(agentWakeupRequests).set({ requestedByActorId: "unrelated-dispatch" })
      .where(eq(agentWakeupRequests.id, receipt.id));
    await heartbeatService(f.db).resumeQueuedRuns();
    expect(await f.db.select().from(heartbeatRuns)).toHaveLength(2);
    const [saved] = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(saved.status).toBe("deferred_issue_execution");
  });
});
