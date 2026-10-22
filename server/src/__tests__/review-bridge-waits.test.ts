import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, documentRevisions, documents, issueDocuments, issueRecoveryActions, issueTreeHolds, issues,
  getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { updateIssueSchema } from "@paperclipai/shared";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { recoveryService } from "../services/recovery/service.js";
import { hasNonDependencyBlockedWait } from "../services/blocked-state-integrity.js";
import { bridgeEventMatches, parseBridgeEvent } from "../services/review-bridge-contract.js";
import { assertBlockedIssueUpdate } from "../services/issue-blocked-validation.js";
import { releaseBridgeWait } from "../services/review-bridge-waits.js";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("bounded review bridge waits", () => {
  const f = bridgeFixture();
  it.each(["false", "true"])("accepts the owner's saved handoff with integrity=%s", async integrity => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", integrity);
    await f.handoff();
    await expect(f.validate()).resolves.toBeUndefined();
    await expect(f.validate({ ...f.wait, owner: "board" })).resolves.toBeUndefined();
    await f.park();
    expect(await hasNonDependencyBlockedWait(f.db, f.issue.id)).toBe(true);
    expect(await collectDispositionRepairSourceState(f.db, { issue: await f.current() }))
      .toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "recorded_wait" });
    await recoveryService(f.db, { enqueueWakeup: f.enqueue }).reconcileStrandedAssignedIssues();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(await f.db.select().from(issueRecoveryActions)).toEqual([]);
  });
  it("rejects reassignment that retains another owner's bridge wait", async () => {
    await f.handoff();
    await f.park();
    await expect(assertBlockedIssueUpdate({ db: f.db,
      actor: { type: "board", userId: "board", source: "local_implicit" }, existing: await f.current(),
      updateFields: { assigneeAgentId: null },
      getDependencyReadiness: async () => ({ unresolvedBlockerCount: 0 }),
    })).rejects.toMatchObject({ status: 403 });
  });
  it("rejects a named user or another agent as the bridge wait owner", async () => {
    await f.handoff();
    for (const owner of [{ userId: "board" }, { agentId: randomUUID() }]) {
      await expect(assertBlockedIssueUpdate({ db: f.db,
        actor: { type: "board", userId: "board", source: "local_implicit" }, existing: await f.current(),
        updateFields: { status: "blocked", unblockDescriptor: { ...f.wait, owner } },
        getDependencyReadiness: async () => ({ unresolvedBlockerCount: 0 }),
      })).rejects.toMatchObject({ status: 422 });
    }
  });
  it("treats an undelivered bridge intent as a durable continuation", async () => {
    await f.park();
    await f.event();
    await f.release();
    expect(await collectDispositionRepairSourceState(f.db, { issue: await f.current() }))
      .toMatchObject({ hasActiveExecutionPath: true });
  });
  it("rejects absent, stale, and mismatched saved handoffs", async () => {
    await expect(f.validate()).rejects.toMatchObject({ status: 422 });
    await f.handoff();
    await expect(f.validate({ ...f.wait, bridge: { ...f.wait.bridge, repo: "another/repo" } }))
      .rejects.toMatchObject({ status: 422 });
    await f.handoff("c".repeat(40));
    await expect(f.validate()).rejects.toMatchObject({ status: 422 });
  });
  it("requires a bounded expiry, target, and valid fields", async () => {
    await f.handoff();
    for (const until of [new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 8 * 86400_000).toISOString()]) {
      await expect(f.validate({ ...f.wait, until })).rejects.toMatchObject({ status: 422 });
    }
    for (const unblockDescriptor of [{ ...f.wait, until: undefined }, { ...f.wait, bridge: undefined },
      { ...f.wait, bridge: { ...f.wait.bridge, head: "bad" } }, { ...f.wait, kind: "human" }]) {
      expect(updateIssueSchema.safeParse({ status: "blocked", unblockDescriptor }).success).toBe(false);
    }
  });
  it("only matches one exact structured event", async () => {
    expect(bridgeEventMatches(f.wait, f.eventBody())).toBe(true);
    for (const change of [{ waitId: randomUUID() }, { head: "b".repeat(40) }, { repo: "other/repo" },
      { pr: 99 }, { stage: "merge_card" as const }]) expect(bridgeEventMatches(f.wait, f.eventBody(change))).toBe(false);
    expect(parseBridgeEvent(`${f.eventBody()}\n${f.eventBody()}`)).toBeNull();
    expect(parseBridgeEvent("```bridge-event\ninvalid\n```")).toBeNull();
    for (const body of [f.eventBody().split("\n").map(line => `> ${line}`).join("\n"),
      f.eventBody().split("\n").map(line => `    ${line}`).join("\n"),
      `\`\`\`\`text\n${f.eventBody()}\n\`\`\`\``]) expect(parseBridgeEvent(body)).toBeNull();
  });
  it("ignores owner-forged and mismatched events", async () => {
    await f.park();
    await f.event({}, "agent");
    await f.event({ waitId: randomUUID() });
    expect(await f.release()).toBeNull();
    expect((await f.current()).status).toBe("blocked");
  });
  it("releases a matching board comment exactly once across concurrent checks", async () => {
    await f.park();
    await f.event();
    const ids = await Promise.all([f.release(), f.release(), f.release()]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect((await f.current()).unblockDescriptor).toBeNull();
    await f.dispatch();
    await f.dispatch();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ reason: "review_bridge_event" });
  });
  it.each(["verdict", "merge_card", "lane_admission"] as const)("releases a board document for %s", async stage => {
    f.wait.bridge.stage = stage;
    await f.park();
    const [document] = await f.db.insert(documents).values({ companyId: f.companyId, latestBody: "Later text." }).returning();
    await f.db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issue.id,
      documentId: document!.id, key: "bridge" });
    await f.db.insert(documentRevisions).values({ companyId: f.companyId, documentId: document!.id,
      revisionNumber: 1, body: f.eventBody(), createdByUserId: "board" });
    expect(await f.release()).toBeTruthy();
    await f.dispatch();
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ reason: "review_bridge_event",
      payload: { bridge: { stage }, documentRevisionId: expect.any(String) } });
  });
  it("wakes once on timeout with a clear reason", async () => {
    f.wait.until = new Date(Date.now() - 1000).toISOString();
    await f.park();
    await Promise.all([f.dispatch(), f.dispatch()]);
    await f.dispatch();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ reason: "review_bridge_timeout",
      contextSnapshot: { until: f.wait.until, bridge: f.wait.bridge } });
  });
  it("defers a timeout wake while the issue tree is paused", async () => {
    f.wait.until = new Date(Date.now() - 1000).toISOString();
    await f.park();
    const [hold] = await f.db.insert(issueTreeHolds).values({ companyId: f.companyId,
      rootIssueId: f.issue.id, mode: "pause", status: "active" }).returning();
    await f.dispatch();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await f.db.select().from(agentWakeupRequests))[0].status).toBe("pending_bridge_dispatch");
    await f.db.update(issueTreeHolds).set({ status: "released" }).where(eq(issueTreeHolds.id, hold!.id));
    await f.dispatch();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("does not release another company's issue", async () => {
    await f.park();
    await f.event();
    expect(await releaseBridgeWait(f.db, randomUUID(), f.issue.id)).toBeNull();
    expect((await f.current()).status).toBe("blocked");
  });
  it("retains a failed wake and retries after restart", async () => {
    await f.park();
    await f.event();
    const deliver = f.enqueue.getMockImplementation()!;
    f.enqueue.mockRejectedValueOnce(new Error("temporary failure"));
    await f.dispatch();
    expect((await f.db.select().from(agentWakeupRequests))[0].status).toBe("pending_bridge_dispatch");
    f.enqueue.mockImplementation(deliver);
    await f.dispatch();
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect((await f.db.select().from(agentWakeupRequests)).filter(row => row.status === "queued")).toHaveLength(1);
  });
  it("does not repeat an admitted wake after a crash before outbox settlement", async () => {
    await f.park();
    await f.event();
    await f.dispatch();
    const [intent] = (await f.db.select().from(agentWakeupRequests)).filter(row => row.status === "completed_bridge_dispatch");
    await f.db.update(agentWakeupRequests).set({ status: "pending_bridge_dispatch" }).where(eq(agentWakeupRequests.id, intent.id));
    await f.dispatch();
    expect((await f.db.select().from(agentWakeupRequests)).filter(row => row.status === "queued")).toHaveLength(1);
  });
  it.each(["active", "escalated", "resolved"])("resets %s disposition recovery on a bridge event", async status => {
    await f.park();
    await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "deliberate_wait_without_target", status, cause: "deliberate_wait_without_target",
      fingerprint: randomUUID(), nextAction: "Automatic recovery stopped.", evidence: { automaticRecovery: { replay: "blocked" } } });
    await f.event();
    await releaseBridgeWait(f.db, f.companyId, f.issue.id);
    expect((await f.db.select().from(issueRecoveryActions))[0]).toMatchObject({ status: "resolved",
      evidence: { automaticRecovery: { replay: "not_required" } } });
    await f.dispatch();
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("preserves an execution safety hold", async () => {
    await f.park();
    await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", status: "escalated", cause: "legacy_execution_requires_reconciliation",
      fingerprint: randomUUID(), nextAction: "Check provider actions.", evidence: { automaticRecovery: { replay: "blocked" } } });
    await releaseBridgeWait(f.db, f.companyId, f.issue.id, true);
    expect((await f.db.select().from(issueRecoveryActions))[0]).toMatchObject({ status: "escalated",
      evidence: { automaticRecovery: { replay: "blocked" } } });
  });
  it("rejects reuse of a consumed wait identifier", async () => {
    await f.handoff();
    await f.park();
    await f.event();
    await f.release();
    await expect(f.validate()).rejects.toMatchObject({ status: 422 });
  });
  it("does not deliver a stale wake after reassignment or a new wait", async () => {
    await f.park();
    await f.event();
    await f.release();
    await f.db.update(issues).set({ status: "blocked", unblockDescriptor: { ...f.wait,
      bridge: { ...f.wait.bridge, waitId: randomUUID() } }, statusVersion: 2 }).where(eq(issues.id, f.issue.id));
    await f.dispatch();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
