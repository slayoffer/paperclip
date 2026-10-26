import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { readWakeupDiagnostics } from "../services/wakeup-diagnostics.js";

const input = { companyId: "company-a", agentId: "agent-a", requestId: "request-a" };
const blockerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixture(receipt: Record<string, unknown> | null, blockers: Array<Record<string, unknown>> = []) {
  const predicates: Array<{ sql: string; params: unknown[] }> = [];
  const query = (rows: Array<Record<string, unknown>>) => ({
    from() { return this; },
    where(condition: SQL) {
      predicates.push(new PgDialect().sqlToQuery(condition));
      return this;
    },
    limit: async () => rows,
    then: (resolve: (rows: Array<Record<string, unknown>>) => unknown) => Promise.resolve(rows).then(resolve),
  });
  const select = vi.fn().mockReturnValueOnce(query(receipt ? [{
    id: input.requestId, status: "skipped", error: null, payload: {}, ...receipt,
  }] : [])).mockReturnValueOnce(query(blockers));
  return { db: { select } as unknown as Db, select, predicates };
}

describe("wakeup skip diagnostics", () => {
  it("returns the stored budget reason, error, and structured usage", async () => {
    const error = "Wake suppressed: this issue used 75854317 input tokens (budget 50000000).";
    const budget = { used: 75854317, limit: 50000000, windowStart: "2026-10-23T03:49:18Z" };
    const { db } = fixture({ reason: "issue.token_budget_exceeded", error, payload: { issueTokenBudget: budget } });
    expect(await readWakeupDiagnostics(db, input)).toEqual({
      wakeupRequestId: input.requestId, reason: "issue.token_budget_exceeded", error, message: error,
      details: { budget },
    });
  });

  it("returns blocker identifiers and status with company-scoped queries", async () => {
    const { db, predicates } = fixture({ reason: "issue_dependencies_blocked", payload: {
      executionWait: { unresolvedBlockerIssueIds: [blockerId, blockerId], requestedIdempotencyKey: "private" },
    } }, [{ id: blockerId, identifier: "TEST-42", status: "in_progress" }]);
    expect((await readWakeupDiagnostics(db, input))?.details).toEqual({
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockers: [{ id: blockerId, identifier: "TEST-42", status: "in_progress" }],
    });
    expect(predicates[1].sql).toContain('"issues"."company_id"');
    expect(predicates[1].params).toEqual([input.companyId, blockerId]);
  });

  it("reads the exact receipt rather than the latest request for the agent", async () => {
    const { db, predicates } = fixture({ reason: "heartbeat.disabled" });
    await readWakeupDiagnostics(db, input);
    expect(predicates[0].params).toEqual([
      input.requestId, input.companyId, input.agentId, "skipped", "deferred_issue_execution", "coalesced",
    ]);
    expect(predicates[0].sql).toContain('"agent_wakeup_requests"."id"');
  });

  it("omits unknown and foreign blocker metadata", async () => {
    const { db } = fixture({ reason: "issue_dependencies_blocked", payload: {
      unresolvedBlockerIssueIds: [blockerId, "not-a-uuid"],
    } });
    expect((await readWakeupDiagnostics(db, input))?.details).toEqual({
      unresolvedBlockerIssueIds: [], unresolvedBlockers: [],
    });
  });

  it.each(["agent.not_invokable", "agent_wip_limit", "execution_replay_blocked", "issue_tree_hold_active"])(
    "preserves the stored reason %s", async (reason) => {
      const { db } = fixture({ reason, error: "The wake cannot start." });
      expect(await readWakeupDiagnostics(db, input)).toMatchObject({ reason, error: "The wake cannot start." });
    },
  );

  it("returns a deferred reconciliation reason and its safe wait details", async () => {
    const { db } = fixture({ status: "deferred_issue_execution", reason: "manual_run", payload: {
      executionWait: { reason: "execution_reconciliation_required", message: "Check the previous run.", recoveryActionId: "action-a" },
    } });
    expect(await readWakeupDiagnostics(db, input)).toMatchObject({
      reason: "execution_reconciliation_required", message: "Check the previous run.",
      details: { executionWait: { recoveryActionId: "action-a" } },
    });
  });

  it("excludes payload secrets and redacts credential text", async () => {
    const { db } = fixture({ reason: "heartbeat.scheduling_suppressed", error: "Authorization: Bearer private-token-value", payload: {
      apiKey: "hidden-key", contextSnapshot: { prompt: "hidden-prompt" },
      heartbeatSkip: { reason: "database_restore_in_progress", token: "hidden-token", nested: { secret: "hidden-secret" } },
      executionWait: { requestedIdempotencyKey: "hidden-idempotency-key" },
    } });
    const result = await readWakeupDiagnostics(db, input);
    expect(result?.details).toEqual({ heartbeatSkip: { reason: "database_restore_in_progress" } });
    expect(JSON.stringify(result)).not.toMatch(/hidden-|private-token-value/);
  });

  it("returns no diagnostics when this invocation has no receipt", async () => {
    const { db } = fixture(null);
    expect(await readWakeupDiagnostics(db, input)).toBeNull();
  });
});
