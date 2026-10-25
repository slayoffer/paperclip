import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues,
  getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";
import { heartbeatService } from "../services/heartbeat.js";
import { dispatchBridgeWakes } from "../services/review-bridge-wakes.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("deferred bridge receipt fairness", () => {
  const f = bridgeFixture();

  it.each(["bridge", "comment"] as const)(
    "admits a ready %s after 50 waiting receipts within two sweeps", async (kind) => {
      vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "1");
      const expiredWait = { ...f.wait, until: new Date(Date.now() - 1000).toISOString() };
      const waiting = Array.from({ length: 50 }, (_, n) => ({
        id: randomUUID(), companyId: f.companyId, assigneeAgentId: f.agentId,
        title: `Waiting ${n}`, status: "blocked", responsibleUserId: "board",
        unblockDescriptor: { ...expiredWait, bridge: { ...f.wait.bridge, waitId: randomUUID() } },
      }));
      await f.db.insert(issues).values(waiting);
      const executors = await f.db.insert(heartbeatRuns).values(waiting.map(issue => ({
        companyId: f.companyId, agentId: f.agentId, status: "queued", runtimeMode: "legacy",
        responsibleUserId: "board", contextSnapshot: { issueId: issue.id },
      }))).returning();
      for (const run of executors) {
        await f.db.update(issues).set({ executionRunId: run.id })
          .where(eq(issues.id, String(run.contextSnapshot?.issueId)));
      }
      const heartbeat = heartbeatService(f.db);
      await dispatchBridgeWakes(f.db, heartbeat.wakeup, { companyId: f.companyId });
      const waitingReceipts = (await f.db.select().from(agentWakeupRequests))
        .filter(row => row.status === "deferred_issue_execution");
      expect(waitingReceipts).toHaveLength(50);
      await f.db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
        .where(inArray(heartbeatRuns.id, executors.map(run => run.id)));
      const waitingIds = waitingReceipts.map(row => row.id);
      await f.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 120_000) })
        .where(inArray(agentWakeupRequests.id, waitingIds));

      let receiptId: string;
      if (kind === "bridge") {
        await f.db.update(issues).set({ status: "blocked", responsibleUserId: "board",
          unblockDescriptor: expiredWait }).where(eq(issues.id, f.issue.id));
        const [hold] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          status: "queued", runtimeMode: "legacy", responsibleUserId: "board",
          contextSnapshot: { issueId: f.issue.id } }).returning();
        await f.db.update(issues).set({ executionRunId: hold.id }).where(eq(issues.id, f.issue.id));
        await dispatchBridgeWakes(f.db, heartbeat.wakeup, { companyId: f.companyId, issueId: f.issue.id });
        const receipt = (await f.db.select().from(agentWakeupRequests))
          .find(row => row.status === "deferred_issue_execution" && row.payload?.issueId === f.issue.id)!;
        expect(receipt).toBeDefined();
        receiptId = receipt.id;
        await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, hold.id));
        await f.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issue.id));
      } else {
        const [comment] = await f.db.insert(issueComments).values({ companyId: f.companyId,
          issueId: f.issue.id, authorUserId: "board", body: "Continue the task." }).returning();
        await f.db.update(issues).set({ responsibleUserId: "board" }).where(eq(issues.id, f.issue.id));
        await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          status: "succeeded", runtimeMode: "legacy", responsibleUserId: "board",
          contextSnapshot: { issueId: f.issue.id }, startedAt: new Date(), finishedAt: new Date() });
        const [receipt] = await f.db.insert(agentWakeupRequests).values({ companyId: f.companyId,
          agentId: f.agentId, source: "issue_comment", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: "board", reason: "issue_commented",
          payload: { issueId: f.issue.id, commentId: comment.id, _paperclipWakeContext: {
            issueId: f.issue.id, wakeReason: "issue_commented", wakeCommentId: comment.id,
            wakeCommentIds: [comment.id],
          } } }).returning();
        receiptId = receipt.id;
      }
      await f.db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 60_000) })
        .where(eq(agentWakeupRequests.id, receiptId));
      const savedReceipt = async () => (await f.db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptId)))[0];

      await heartbeatService(f.db).resumeQueuedRuns();
      expect((await savedReceipt()).status).toBe("deferred_issue_execution");
      await heartbeatService(f.db).resumeQueuedRuns();
      const ready = await savedReceipt();
      expect(ready.status).toBe("queued");
      expect(ready.runId).toEqual(expect.any(String));
      await heartbeatService(f.db).resumeQueuedRuns();
      expect((await savedReceipt()).runId).toBe(ready.runId);
      const stillWaiting = await f.db.select().from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.id, waitingIds));
      expect(stillWaiting.every(row => row.status === "deferred_issue_execution")).toBe(true);
      const liveExecutors = await f.db.select().from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, executors.map(run => run.id)));
      expect(liveExecutors.every(run => run.status === "running")).toBe(true);
    }, 60_000);
});
