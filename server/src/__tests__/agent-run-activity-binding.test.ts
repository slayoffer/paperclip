import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { attentionService } from "../services/attention.js";
import { listNewerAgentRunActivity } from "../services/agent-run-activity.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("newer activity canonical issue binding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-activity-binding-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it.each(["native", "first-class", "snapshot", "task", "first-class-conflict", "native-conflict", "blank-snapshot", "invalid-snapshot"])(
    "suppresses only the canonical issue's failure for %s", async (kind) => {
      const companyId = randomUUID(), agentId = randomUUID();
      const issueId = randomUUID(), otherIssueId = randomUUID();
      const failedAt = new Date("2026-07-09T12:00:00Z");
      const newerAt = new Date("2026-07-09T12:01:00Z");
      await db.insert(companies).values({ id: companyId, name: "Activity binding", issuePrefix: `A${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local" });
      await db.insert(issues).values([issueId, otherIssueId].map((id, i) => ({
        id, companyId, title: "Recoverable task", identifier: `B${companyId}-${i + 1}`, status: "in_progress",
      })));
      const failures = [issueId, otherIssueId].map((id) => ({
        id: randomUUID(), companyId, agentId, status: "failed", error: "adapter failed",
        contextSnapshot: { issueId: id }, createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
      }));
      await db.insert(heartbeatRuns).values(failures);
      await db.insert(heartbeatRunEvents).values(failures.map((run) => ({
        companyId, agentId, runId: run.id, seq: 1, eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      })));
      const native = kind === "native" || kind === "native-conflict";
      const firstClass = kind === "first-class" || kind === "first-class-conflict";
      const snapshot = kind === "snapshot" ? { issueId: ` ${issueId} ` }
        : kind === "task" ? { taskId: issueId }
        : kind === "blank-snapshot" ? { issueId: "  ", taskId: issueId }
        : kind === "invalid-snapshot" ? { issueId: 42, taskId: issueId }
        : kind.endsWith("conflict") ? { issueId: otherIssueId, taskId: otherIssueId } : {};
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
        nativeIssueId: native ? issueId : null,
        issueId: firstClass ? issueId : kind === "native-conflict" ? otherIssueId : null,
        contextSnapshot: snapshot, createdAt: newerAt, updatedAt: newerAt, finishedAt: newerAt,
      });
      const projected = await listNewerAgentRunActivity(db, companyId, [agentId], failedAt);
      expect(projected).toEqual([{ agentId, createdAt: newerAt, runIssueId: issueId, runTaskId: null }]);
      expect(await listNewerAgentRunActivity(db, randomUUID(), [agentId], failedAt)).toEqual([]);
      expect(await listNewerAgentRunActivity(db, companyId, [agentId], newerAt)).toEqual([]);
      const feed = await attentionService(db).list(companyId, { userId: "board-user" });
      expect(feed.items.filter((item) => item.sourceKind === "failed_run").map((item) => item.subject.id))
        .toEqual([failures[1]!.id]);
    },
  );
});
