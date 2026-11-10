import express from "express";
import { randomUUID } from "node:crypto";
import { agents, companies, heartbeatRuns, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { commitToolActionReview } from "../../services/tool-action-review.js";

export async function resolutionFixture(db: Db, source: Express.Request["actor"]["source"] = "session") {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Resolution v2", issuePrefix: `V${companyId.slice(0, 7)}` });
  const [agent] = await db.insert(agents).values({
    companyId, name: "Resolver", role: "engineer", adapterType: "process", status: "idle",
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId, title: "Resolution v2", status: "in_progress", assigneeAgentId: agent.id,
  }).returning();
  const [run] = await db.insert(heartbeatRuns).values({
    companyId, agentId: agent.id, status: "running", nativeIssueId: issue.id, contextSnapshot: { issueId: issue.id },
  }).returning();
  const keyId = randomUUID();
  const actor: Express.Request["actor"] = source === "agent_key" || source === "agent_jwt"
    ? { type: "agent", source, agentId: agent.id, companyId, runId: run.id }
    : { type: "board", source, userId: "same-user", keyId,
      companyIds: [companyId], isInstanceAdmin: true };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", issueRoutes(db, {} as never, {
    approveToolActionRequest: (input) => commitToolActionReview(db, { ...input, decision: "approved" }),
    declineToolActionRequest: (input) => commitToolActionReview(db, { ...input, decision: "rejected" }),
  }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    issue, agent, actor, server, keyId,
    async card() {
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId, issueId: issue.id, kind: "request_confirmation", continuationPolicy: "none",
        payload: { version: 1, prompt: "Continue?" },
      }).returning();
      return row;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
