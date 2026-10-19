import { describe, expect, it } from "vitest";
import { buildCompanyFlowReport, type FlowIssueRow, type FlowSnapshot } from "../services/company-flow-model.js";

const now = new Date("2026-10-19T12:00:00Z");
function issue(id: string, fields: Partial<FlowIssueRow> = {}): FlowIssueRow {
  return {
    id, identifier: id, title: id, status: "todo", priority: "medium", parentId: null,
    assigneeAgentId: "owner", assigneeUserId: null, checkoutRunId: null, executionRunId: null,
    createdAt: new Date("2026-10-18T12:00:00Z"), updatedAt: new Date("2026-10-19T11:00:00Z"),
    executionVisible: true, ...fields,
  };
}
function report(issues: FlowIssueRow[], fields: Partial<FlowSnapshot> = {}, limit: number | null = 3) {
  return buildCompanyFlowReport("company", {
    issues, agents: [{ id: "owner", name: "Owner", status: "idle" }], relations: [], decisions: [], runs: [], ...fields,
  }, now, limit);
}
const edge = (issueId: string, relatedIssueId: string) => ({ issueId, relatedIssueId });

describe("company flow projection", () => {
  it("separates backlog, sorts priority and age, and excludes open blockers and pending decisions", () => {
    const result = report([
      issue("ordinary"), issue("high", { priority: "high" }),
      issue("older", { createdAt: new Date("2026-10-17T12:00:00Z") }),
      issue("backlog", { status: "backlog" }), issue("pending"), issue("blocked"),
      issue("closed", { status: "done" }), issue("cleared"), issue("hidden", { executionVisible: false }),
    ], { relations: [edge("ordinary", "blocked"), edge("closed", "cleared")], decisions: [{ issueId: "pending" }] });
    expect(result.readyQueues[0]!.todo.map((row) => row.id)).toEqual(["high", "older", "cleared", "ordinary"]);
    expect(result.readyQueues[0]!.backlog.map((row) => row.id)).toEqual(["backlog"]);
    expect(result.readyQueues[0]!.todo[0]).toMatchObject({ ageMs: 86400000, unchangedForMs: 3600000 });
  });

  it("counts each transitive dependent once across diamonds and cycles", () => {
    const result = report([issue("a"), issue("b"), issue("c"), issue("d"), issue("done", { status: "done" })], {
      relations: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("d", "a"),
        edge("a", "done"), edge("foreign", "a"), edge("a", "foreign")],
    });
    expect(result.chainRoots.map((root) => root.transitiveDependentCount)).toEqual([3, 3, 3, 3]);
    expect(result.chainRoots[0]!.issue.openBlockerIds).toEqual(["d"]);
  });

  it("uses the exact WIP predicate, preserves weekly WIP, and reports stall signals", () => {
    const result = report([
      issue("root"), issue("doing", { status: "in_progress" }), issue("waiting", { status: "blocked" }),
      issue("later", { status: "backlog" }), issue("review", { status: "in_review" }),
      issue("round", { title: "Review r1: root @ sha", parentId: "root" }),
    ], { agents: [{ id: "owner", name: "Owner", status: "error" }], relations: [edge("root", "later")] });
    expect(result.agents[0]).toMatchObject({ wip: 4, wipLimit: 3, atWipLimit: true });
    expect(result.scorecard.wip).toBe(2);
    expect(result.scorecard.counts.wip).toBe(3);
    expect(result.scorecard.byOwner[0]!.counts).toEqual(result.scorecard.counts);
    expect(result.chainRoots[0]!.reasons).toEqual(["owner_at_wip_limit", "owner_error"]);
    expect(report([issue("a")], {}, null).agents[0]!.atWipLimit).toBe(false);
  });

  it("does not accept stale or unrelated run pointers as live work", () => {
    const result = report([
      issue("stale", { status: "in_progress", checkoutRunId: "ended" }),
      issue("wrong", { status: "in_progress", executionRunId: "unrelated" }),
      issue("wrong-owner", { status: "in_progress" }),
      issue("native", { status: "in_progress" }),
      issue("pointer", { status: "in_progress", executionRunId: "linked" }),
    ], { runs: [
      { id: "unrelated", agentId: "owner", issueId: "different" },
      { id: "native-run", agentId: "owner", issueId: "native" },
      { id: "other-owner", agentId: "another", issueId: "wrong-owner" },
      { id: "linked", agentId: "owner", issueId: null },
    ] });
    expect(result.ghosts.inProgressWithoutRun.map((row) => row.id)).toEqual(["stale", "wrong", "wrong-owner"]);
  });

  it("finds closed blocker links and review holds without open rounds", () => {
    const result = report([
      issue("done", { status: "done" }), issue("cancelled", { status: "cancelled" }),
      issue("ghost", { status: "blocked" }), issue("empty", { status: "blocked" }),
      issue("orphan", { title: "Review hold: root (bridge-owned, do not edit)", status: "backlog" }),
      issue("hold", { title: "Review hold: other (bridge-owned, do not edit)", parentId: "other" }),
      issue("round", { title: "Review r1: other @ head", parentId: "other" }),
      issue("closed-round", { title: "Review r1: root @ head", status: "done" }),
    ], { relations: [edge("done", "ghost"), edge("cancelled", "ghost")] });
    expect(result.ghosts.blockedWithClosedLinks.map((row) => row.id)).toEqual(["ghost"]);
    expect(result.ghosts.reviewHoldsWithoutRound.map((row) => row.id)).toEqual(["orphan"]);
    expect(result.readyQueues.flatMap((queue) => [...queue.todo, ...queue.backlog]).some((row) => row.id === "hold")).toBe(false);
  });

  it("keeps human assignments separate from unassigned issues and excludes holds", () => {
    const result = report([
      issue("free", { assigneeAgentId: null }),
      issue("human", { assigneeAgentId: null, assigneeUserId: "human" }),
      issue("hold", { assigneeAgentId: null, title: "Review hold: x" }),
    ]);
    expect(result.unassigned.map((row) => row.id)).toEqual(["free"]);
    expect(result.readyQueues).toHaveLength(2);
    expect(result.scorecard.byOwner).toHaveLength(2);
  });
});
