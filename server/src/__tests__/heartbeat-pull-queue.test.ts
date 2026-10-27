import "./heartbeat-pull-queue.cases.js";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { isPullQueueSignal } from "../services/pull-queue.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

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
    expect(isPullQueueSignal({ type: "activity.logged", payload: { entityType: "issue", action } } as LiveEvent)).toBe(true);
  });
  it("selects work after a terminal run and ignores run output", () => {
    expect(isPullQueueSignal({ type: "heartbeat.run.status", payload: { status: "succeeded" } } as LiveEvent)).toBe(true);
    expect(isPullQueueSignal({ type: "heartbeat.run.status", payload: { status: "running" } } as LiveEvent)).toBe(false);
    expect(isPullQueueSignal({ type: "heartbeat.run.event", payload: {} } as LiveEvent)).toBe(false);
  });
});
