import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agents, approvals, companies, heartbeatRuns, issueApprovals, issueRelations,
  issues, issueThreadInteractions, type Db,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { agentWipLimit } from "./agent-wip-limit.js";
import { buildCompanyFlowReport } from "./company-flow-model.js";
import { executionIssueCondition } from "./issue-visibility.js";

export function companyFlowService(db: Db) {
  return {
    report: (companyId: string) => db.transaction(async (tx) => {
      const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      if (!company) throw notFound("Company not found");
      const collectedAt = new Date();
      // Fixed query count. Do not read comments, decision payloads, logs, or agent configuration.
      const [issueRows, agentRows, relations, interactions, approvalRows, runs] = await Promise.all([
        tx.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status,
          priority: issues.priority, parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId,
          createdAt: issues.createdAt, updatedAt: issues.updatedAt,
          executionVisible: sql<boolean>`${executionIssueCondition()}`,
        }).from(issues).where(eq(issues.companyId, companyId)),
        tx.select({ id: agents.id, name: agents.name, status: agents.status })
          .from(agents).where(eq(agents.companyId, companyId)),
        tx.select({ issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId })
          .from(issueRelations).where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
        tx.select({ issueId: issueThreadInteractions.issueId }).from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.status, "pending"))),
        tx.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
          .innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId)))
          .where(and(eq(issueApprovals.companyId, companyId), inArray(approvals.status, ["pending", "revision_requested"]))),
        tx.select({
          id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
          issueId: sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text,
            ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
        }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"]), isNull(heartbeatRuns.finishedAt),
        )),
      ]);
      return buildCompanyFlowReport(companyId, {
        issues: issueRows, agents: agentRows, relations, decisions: [...interactions, ...approvalRows], runs,
      }, collectedAt, agentWipLimit());
    }, { isolationLevel: "repeatable read", accessMode: "read only" }),
  };
}
