import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { agentIssueCreateLimits, agentIssueCreateRefusal, loadAgentIssueCreateCounts } from "./agent-issue-create-limits.js";
import { agentWipFull } from "./agent-wip-limit.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface IssueCreateAdmission {
  actor: { type: string; source?: string; agentId?: string | null };
  skipCreateLimits: boolean;
}

export function hasIssueCreateQuota(admission: IssueCreateAdmission | undefined): boolean {
  return Boolean(admission?.actor.type === "agent" && admission.actor.agentId && !admission.skipCreateLimits
    && Object.values(agentIssueCreateLimits()).some(limit => limit !== null));
}

/** The caller holds issue-privacy-tree for the company through insertion. */
export async function assertIssueCreateQuota(
  tx: Transaction, companyId: string, parentId: string | null | undefined,
  admission: IssueCreateAdmission, requested = 1,
) {
  const limits = agentIssueCreateLimits();
  if (admission.actor.type === "agent" && admission.actor.agentId && !admission.skipCreateLimits
    && Object.values(limits).some(limit => limit !== null)) {
    const counts = await loadAgentIssueCreateCounts(tx, {
      companyId, agentId: admission.actor.agentId, parentId: parentId ?? null, limits,
    });
    const [parent] = parentId ? await tx.select({ identifier: issues.identifier }).from(issues)
      .where(and(eq(issues.id, parentId), eq(issues.companyId, companyId))) : [];
    const refusal = agentIssueCreateRefusal(limits, counts, parentId ? parent?.identifier ?? parentId : null, requested);
    if (refusal) throw conflict(refusal, { code: "agent_issue_create_limit", limits, counts });
  }
}

export async function applyIssueCreateAdmission(
  tx: Transaction,
  companyId: string,
  data: { parentId?: string | null; assigneeAgentId?: string | null; status?: string; priority?: string },
  admission: IssueCreateAdmission,
) {
  await assertIssueCreateQuota(tx, companyId, data.parentId, admission);
  if (await agentWipFull(tx, admission.actor, {
    companyId, agentId: data.assigneeAgentId, status: data.status ?? "backlog", priority: data.priority,
  })) data.status = "backlog";
}
