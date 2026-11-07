import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { companyFlowService } from "../services/company-flow.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("company flow canonical run binding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-flow-binding-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it.each(["native", "first-class", "snapshot", "task", "first-class-conflict", "native-conflict"])(
    "attributes active work to the canonical issue for %s", async (kind) => {
      const companyId = randomUUID(), agentId = randomUUID();
      const issueId = randomUUID(), otherIssueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Flow binding", issuePrefix: `F${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "codex_local" });
      await db.insert(issues).values([issueId, otherIssueId].map((id) => ({
        id, companyId, title: "Active task", status: "in_progress", assigneeAgentId: agentId,
      })));
      const native = kind === "native" || kind === "native-conflict";
      const firstClass = kind === "first-class" || kind === "first-class-conflict";
      await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
        nativeIssueId: native ? issueId : null,
        issueId: firstClass ? issueId : kind === "native-conflict" ? otherIssueId : null,
        contextSnapshot: kind === "snapshot" ? { issueId } : kind === "task" ? { taskId: issueId }
          : kind.endsWith("conflict") ? { issueId: otherIssueId, taskId: otherIssueId } : {},
      });
      const report = await companyFlowService(db).report(companyId);
      expect(report.ghosts.inProgressWithoutRun.map((issue) => issue.id)).toEqual([otherIssueId]);
    },
  );
});
