import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, agentWakeupRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoverQueuedRuns } from "../services/queued-run-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('deferred queue canonical run binding', () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-binding-regression-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function fixture(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding fixture", issuePrefix: `B${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "idle", adapterType: "process" });
    await db.insert(issues).values([issueId, otherIssueId].map((id) => ({
      id, companyId, title: "Binding task", status, assigneeAgentId: agentId,
    })));
    return { companyId, agentId, issueId, otherIssueId };
  }

  it.each(["first-class", "native", "conflicting-latest", "live-first-class", "live-conflict"])(
    "uses canonical live exclusion and latest completion for %s", async kind => {
      const f = await fixture();
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "automation", status: "deferred_issue_execution", payload: { issueId: f.issueId, mutation: "interaction" } });
      const earlier = new Date(Date.now() - 60_000);
      const [completed] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", runtimeMode: "legacy", finishedAt: earlier, createdAt: earlier,
        issueId: kind === "native" ? null : f.issueId, nativeIssueId: kind === "native" ? f.issueId : null,
        contextSnapshot: {},
      }).returning();
      if (kind === "conflicting-latest" || kind.startsWith("live-")) {
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          status: kind.startsWith("live-") ? "running" : "cancelled", runtimeMode: "legacy",
          issueId: kind === "live-first-class" ? f.issueId : f.otherIssueId,
          contextSnapshot: kind === "live-first-class" ? {} : { issueId: f.issueId },
          finishedAt: kind.startsWith("live-") ? null : new Date(),
        });
      }
      const release = vi.fn(async () => {});
      await recoverQueuedRuns(db, {
        getSchedulingSuppression: async () => ({ suppressed: false }), resumeExecutionWaitComments: async () => {},
        getWorktreeExecutionCutoff: async () => null, resumeQueuedCommentInterrupt: async () => {},
        readQueuedInteractionResponse: async () => ({ answered: true }),
        isHeartbeatRunTerminalStatus: (status) => ["cancelled", "succeeded", "failed"].includes(status),
        resumeSavedLegacyComments: async () => {}, releaseIssueExecutionAndPromote: release,
        resumeDeferredBridgeReceipt: async () => {}, startNextQueuedRunForAgent: async () => {},
      });
      if (kind === "live-first-class") expect(release).not.toHaveBeenCalledWith(
        expect.objectContaining({ companyId: f.companyId }), expect.anything());
      else expect(release).toHaveBeenCalledWith(expect.objectContaining({ id: completed.id }),
        { suppressImmediateRecovery: true, resumeStrandedQueue: true });
    },
  );

});
