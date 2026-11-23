import "./heartbeat-pull-queue.cases.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { isPullQueueSignal } from "../services/pull-queue.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

function liveEvent(type: LiveEvent["type"], payload: LiveEvent["payload"]): LiveEvent {
  return { id: 1, companyId: randomUUID(), createdAt: new Date().toISOString(), type, payload };
}

describe("pull queue monitor and event contracts", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("refuses a status change that would silently cancel a monitor", () => {
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    const owner = randomUUID();
    const nextCheckAt = new Date(Date.now() + 3_600_000);
    const policy = normalizeIssueExecutionPolicy({ stages: [], monitor: { nextCheckAt: nextCheckAt.toISOString(), scheduledBy: "board" } })!;
    const input = { issue: { status: "in_progress", assigneeAgentId: owner,
      executionPolicy: policy, monitorNextCheckAt: nextCheckAt },
      policy, previousPolicy: policy, requestedStatus: "backlog", requestedAssigneePatch: {}, actor: { agentId: owner } };
    expect(() => applyIssueExecutionPolicyTransition(input)).toThrow(expect.objectContaining({ status: 409 }));
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "false");
    expect(applyIssueExecutionPolicyTransition(input).patch.monitorNextCheckAt).toBeNull();
  });

  it.each(["issue.updated", "issue.created", "issue.thread_interaction_answered", "issue.thread_interaction_accepted"])("selects work after %s", (action) => {
    expect(isPullQueueSignal(liveEvent("activity.logged", { entityType: "issue", action }))).toBe(true);
  });
  it("reconsiders assignments when an agent resumes or a company returns to active status", () => {
    expect(isPullQueueSignal(liveEvent("activity.logged", { entityType: "agent", action: "agent.resumed" }))).toBe(true);
    expect(isPullQueueSignal(liveEvent("agent.status", { status: "idle" }))).toBe(true);
    expect(isPullQueueSignal(liveEvent("activity.logged", {
      entityType: "company", action: "company.updated", details: { status: "active" },
    }))).toBe(true);
    expect(isPullQueueSignal(liveEvent("agent.status", { status: "running" }))).toBe(false);
  });
  it("selects work after a terminal run and ignores run output", () => {
    expect(isPullQueueSignal(liveEvent("heartbeat.run.status", { status: "succeeded" }))).toBe(true);
    expect(isPullQueueSignal(liveEvent("heartbeat.run.status", { status: "running" }))).toBe(false);
    expect(isPullQueueSignal(liveEvent("heartbeat.run.event", {}))).toBe(false);
  });
});
