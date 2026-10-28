import type { CompanyFlowReport, FlowAgent, FlowCounts, FlowIssue, FlowStallReason } from "@paperclipai/shared/types/company-flow";
import { isWipActiveStatus } from "./agent-wip-limit.js";
import { isRunnableWipReason, isWaitingWipReason, type WipReason } from "./agent-wip-policy.js";

export interface FlowIssueRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
  executionVisible: boolean;
  wipReason?: WipReason;
}

export interface FlowSnapshot {
  issues: FlowIssueRow[];
  agents: Array<{ id: string; name: string; status: string }>;
  relations: Array<{ issueId: string; relatedIssueId: string }>;
  decisions: Array<{ issueId: string }>;
  runs: Array<{ id: string; agentId: string; issueId: string | null }>;
  pendingFinalizeBlockerIssueIds: string[];
}

const closed = (status: string) => status === "done" || status === "cancelled";
const hold = (title: string) => title.startsWith("Review hold:");
const realWork = (title: string) => !/^(Review hold:|Review r|Gate )/.test(title);
const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const issueOrder = (a: FlowIssue, b: FlowIssue) =>
  (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4) || b.ageMs - a.ageMs || a.id.localeCompare(b.id);
const ownerKey = (issue: { assigneeAgentId: string | null; assigneeUserId: string | null }) =>
  JSON.stringify([issue.assigneeAgentId, issue.assigneeUserId]);

export function buildCompanyFlowReport(
  companyId: string,
  snapshot: FlowSnapshot,
  now: Date,
  wipLimit: number | null,
): CompanyFlowReport {
  const rows = new Map(snapshot.issues.map((issue) => [issue.id, issue]));
  const pendingFinalize = new Set(snapshot.pendingFinalizeBlockerIssueIds);
  const open = snapshot.issues.filter((issue) => issue.executionVisible && !closed(issue.status));
  const decisions = new Map<string, number>();
  for (const row of snapshot.decisions) decisions.set(row.issueId, (decisions.get(row.issueId) ?? 0) + 1);
  const blockers = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const edge of snapshot.relations) {
    const source = rows.get(edge.issueId);
    const target = rows.get(edge.relatedIssueId);
    // A relation must have two company-scoped endpoints. Closed links still explain blocked ghosts.
    if (!source || !target) continue;
    if (!blockers.has(target.id)) blockers.set(target.id, new Set());
    blockers.get(target.id)!.add(source.id);
    if (closed(source.status) || closed(target.status) || !source.executionVisible || !target.executionVisible) continue;
    if (!dependents.has(source.id)) dependents.set(source.id, new Set());
    dependents.get(source.id)!.add(target.id);
  }
  const wip = new Map<string, number>();
  const waiting = new Map<string, number>();
  const runnable = (row: FlowIssueRow) => row.wipReason === undefined
    ? isWipActiveStatus(row.status) : isRunnableWipReason(row.wipReason);
  for (const row of snapshot.issues) {
    if (row.assigneeAgentId && runnable(row)) {
      wip.set(row.assigneeAgentId, (wip.get(row.assigneeAgentId) ?? 0) + 1);
    }
    if (row.assigneeAgentId && row.wipReason && isWaitingWipReason(row.wipReason)) {
      waiting.set(row.assigneeAgentId, (waiting.get(row.assigneeAgentId) ?? 0) + 1);
    }
  }
  const agents: FlowAgent[] = snapshot.agents.map((agent) => ({
    ...agent,
    wip: wip.get(agent.id) ?? 0,
    runnableWip: wip.get(agent.id) ?? 0,
    waitingWip: waiting.get(agent.id) ?? 0,
    wipLimit,
    atWipLimit: wipLimit !== null && (wip.get(agent.id) ?? 0) >= wipLimit,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const references = new Map<string, FlowIssue>(open.map((row) => [row.id, {
    id: row.id, identifier: row.identifier, title: row.title, status: row.status, priority: row.priority,
    assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId,
    ageMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
    unchangedForMs: Math.max(0, now.getTime() - row.updatedAt.getTime()),
    openBlockerIds: [...(blockers.get(row.id) ?? [])]
      .filter((id) => rows.get(id)!.status !== "done" || pendingFinalize.has(id)).sort(),
    pendingDecisionCount: decisions.get(row.id) ?? 0,
  }]));
  const issues = [...references.values()].sort(issueOrder);
  const readyQueues: CompanyFlowReport["readyQueues"] = [];
  const queueByOwner = new Map<string, CompanyFlowReport["readyQueues"][number]>();
  for (const issue of issues) {
    if (hold(issue.title) || issue.openBlockerIds.length || issue.pendingDecisionCount) continue;
    if (issue.status !== "todo" && issue.status !== "backlog") continue;
    const key = ownerKey(issue);
    let queue = queueByOwner.get(key);
    if (!queue) {
      queue = { assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, todo: [], backlog: [] };
      queueByOwner.set(key, queue);
      readyQueues.push(queue);
    }
    queue[issue.status].push(issue);
  }
  readyQueues.sort((a, b) => ownerKey(a).localeCompare(ownerKey(b)));

  const runsById = new Map(snapshot.runs.map((run) => [run.id, run]));
  const runsByIssue = new Map<string, Set<string>>();
  for (const run of snapshot.runs) {
    if (!run.issueId) continue;
    if (!runsByIssue.has(run.issueId)) runsByIssue.set(run.issueId, new Set());
    runsByIssue.get(run.issueId)!.add(run.agentId);
  }
  const hasRun = (issue: FlowIssue) => {
    if (!issue.assigneeAgentId) return false;
    if (runsByIssue.get(issue.id)?.has(issue.assigneeAgentId)) return true;
    const row = rows.get(issue.id)!;
    return [row.checkoutRunId, row.executionRunId].some((id) => {
      const run = id ? runsById.get(id) : null;
      return run?.agentId === issue.assigneeAgentId && (!run.issueId || run.issueId === issue.id);
    });
  };
  const openRoundParents = new Set<string>();
  const openRoundIdentifiers = new Set<string>();
  for (const issue of open) {
    if (!/^Review r\d+:/.test(issue.title)) continue;
    if (issue.parentId) openRoundParents.add(issue.parentId);
    const identifier = /^Review r\d+:\s+(\S+)/.exec(issue.title)?.[1];
    if (identifier) openRoundIdentifiers.add(identifier);
  }
  const orphanHold = (issue: FlowIssue) => {
    if (!hold(issue.title)) return false;
    const row = rows.get(issue.id)!;
    const identifier = /^Review hold:\s+([^\s(]+)/.exec(row.title)?.[1];
    return !(row.parentId && openRoundParents.has(row.parentId)) && !(identifier && openRoundIdentifiers.has(identifier));
  };
  const ghosts = {
    inProgressWithoutRun: issues.filter((issue) => issue.status === "in_progress" && !hasRun(issue)),
    blockedWithClosedLinks: issues.filter((issue) => issue.status === "blocked" &&
      (blockers.get(issue.id)?.size ?? 0) > 0 && issue.openBlockerIds.length === 0),
    reviewHoldsWithoutRound: issues.filter(orphanHold),
  };
  const unassigned = issues.filter((issue) => !issue.assigneeAgentId && !issue.assigneeUserId && !hold(issue.title));
  const chainRoots = issues.filter((issue) => dependents.has(issue.id)).map((issue) => {
    const visited = new Set([issue.id]);
    const queue = [...dependents.get(issue.id)!];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const dependent of dependents.get(id) ?? []) if (!visited.has(dependent)) queue.push(dependent);
    }
    const owner = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? null : null;
    const reasons: FlowStallReason[] = [];
    if (issue.pendingDecisionCount) reasons.push("pending_decision");
    if (issue.openBlockerIds.length) reasons.push("open_blocker");
    if (owner?.atWipLimit) reasons.push("owner_at_wip_limit");
    if (owner?.status === "error") reasons.push("owner_error");
    if (owner?.status === "paused") reasons.push("owner_paused");
    if (orphanHold(issue)) reasons.push("review_hold_without_round");
    if (issue.status === "in_progress" && !hasRun(issue)) reasons.push("in_progress_without_run");
    if (!issue.assigneeAgentId && !issue.assigneeUserId) reasons.push("unassigned");
    return { issue, transitiveDependentCount: visited.size - 1, owner, reasons };
  }).sort((a, b) => b.transitiveDependentCount - a.transitiveDependentCount || issueOrder(a.issue, b.issue));

  const count = (include: (issue: Pick<FlowIssue, "title" | "assigneeAgentId" | "assigneeUserId">) => boolean): FlowCounts => ({
    readyTodo: readyQueues.reduce((sum, queue) => sum + queue.todo.filter(include).length, 0),
    readyBacklog: readyQueues.reduce((sum, queue) => sum + queue.backlog.filter(include).length, 0),
    chainRoots: chainRoots.filter((root) => include(root.issue)).length,
    wip: snapshot.issues.filter((row) => include(row) && runnable(row)).length,
    inProgressWithoutRun: ghosts.inProgressWithoutRun.filter(include).length,
    blockedWithClosedLinks: ghosts.blockedWithClosedLinks.filter(include).length,
    reviewHoldsWithoutRound: ghosts.reviewHoldsWithoutRound.filter(include).length,
    unassigned: unassigned.filter(include).length,
  });
  const owners = new Map(snapshot.issues.filter((issue) => realWork(issue.title)).map((issue) => [ownerKey(issue), {
    assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
  }]));
  const scorecardWip = (key?: string) => snapshot.issues.filter((issue) => realWork(issue.title) &&
    (key === undefined || ownerKey(issue) === key) && (issue.status === "todo" || issue.status === "in_progress")).length;
  return {
    companyId, collectedAt: now.toISOString(), readyQueues, chainRoots,
    agents: agents.filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval"),
    ghosts, unassigned, counts: count(() => true),
    scorecard: {
      counts: count((issue) => realWork(issue.title)), wip: scorecardWip(),
      byOwner: [...owners.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, owner]) => ({
        ...owner, counts: count((issue) => realWork(issue.title) && ownerKey(issue) === key), wip: scorecardWip(key),
      })),
    },
  };
}
