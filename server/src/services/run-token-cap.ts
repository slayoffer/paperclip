import { and, desc, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { isRunTokenCapStop, readRunTokenCapConfig, type AdapterRuntime } from "@paperclipai/adapter-utils";
import { readLatestUsageSample } from "./owner-sessions.js";
import { readRawUsageTotals } from "./session-usage.js";
import { getIssueContinuationSummaryDocument, refreshIssueContinuationSummary } from "./issue-continuation-summary.js";
import { issueTokenBudgetConfig, loadIssueTokenBudgetState } from "./issue-token-budget.js";
import { logger } from "../middleware/logger.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Wakeup = (agentId: string, options: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  idempotencyKey: string;
  requestedByActorType: "system";
  issueStateGuard: { statuses: string[]; assigneeAgentId: string };
  allowRunCoalescing: boolean;
  payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

/** Cap stops and their one successor have a continuation owner, not a recovery failure. */
export function ownsRunTokenCapContinuation(run: {
  status: string; resultJson?: unknown; contextSnapshot?: unknown;
} | null | undefined) {
  const context = run?.contextSnapshot as Record<string, unknown> | null;
  return isRunTokenCapStop(run) ||
    (run?.status === "succeeded" && typeof context?.runTokenCapSourceRunId === "string");
}

export async function runTokenCapBaseline(db: Db, input: {
  agentId: string; runId: string; adapterType: string; runtime: AdapterRuntime;
}) {
  if (input.adapterType !== "codex_local" || !readRunTokenCapConfig()) return {};
  const sessionId = input.runtime.sessionDisplayId ?? input.runtime.sessionId;
  if (!sessionId) return {};
  const usage = await readLatestUsageSample(db, {
    agentId: input.agentId, excludeRunId: input.runId, sessionId,
  }, readRawUsageTotals);
  return { paperclipRunTokenCapBaseline: { sessionId, inputTokens: usage?.inputTokens ?? 0 } };
}

/** One automatic successor per cap chain. Normal wake admission checks all current gates again. */
export async function continueRunTokenCap(db: Db, run: Run, wakeup: Wakeup) {
  try { await enqueueRunTokenCapContinuation(db, run, wakeup); }
  catch (err) { logger.warn({ err, runId: run.id }, "Cap continuation remains pending for the next sweep"); }
}

async function enqueueRunTokenCapContinuation(db: Db, run: Run, wakeup: Wakeup) {
  if (!isRunTokenCapStop(run) || run.contextSnapshot?.runTokenCapSourceRunId) return;
  // Terminal success saves this ID before the task-session write. Never resume an older checkpoint.
  if (!run.sessionIdAfter?.trim()) return;
  const issueId = run.contextSnapshot?.issueId;
  if (typeof issueId !== "string") return;
  const key = `run_token_cap:${run.companyId}:${issueId}:${run.id}`;
  await withDedicatedDbConnection(db, (dedicated) => dedicated.transaction(async (tx) => {
    // Keep the normal pool available while wake admission and handoff writes use it.
    // The lock serializes finalizers. The wake receipt survives a process restart.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
    const [existing] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.idempotencyKey, key))).limit(1);
    if (existing) return;
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId))).limit(1);
    if (!issue || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId || issue.conversationAgentId ||
        !["todo", "in_progress"].includes(issue.status)) return;
    const [latest] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.contextIssueId, issueId)))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if (latest?.id !== run.id) return;
    const config = issueTokenBudgetConfig();
    if (config && (await loadIssueTokenBudgetState(tx as unknown as Db, {
      companyId: run.companyId, issueId, config,
    })).exceeded) return;
    // Never admit a successor after a failed handoff write.
    let summary = await getIssueContinuationSummaryDocument(tx as unknown as Db, issueId);
    if (!summary?.body.includes(`Last updated by run: ${run.id}`)) {
      const [agent] = await tx.select().from(agents)
        .where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId))).limit(1);
      if (!agent) return;
      await refreshIssueContinuationSummary({ db, issueId, run, agent });
      summary = await getIssueContinuationSummaryDocument(tx as unknown as Db, issueId);
      if (!summary?.body.includes(`Last updated by run: ${run.id}`)) return;
    }
    await wakeup(run.agentId, {
      source: "automation", triggerDetail: "system", reason: "run_token_cap",
      idempotencyKey: key, requestedByActorType: "system",
      issueStateGuard: { statuses: ["todo", "in_progress"], assigneeAgentId: run.agentId },
      allowRunCoalescing: false,
      payload: { issueId, sourceRunId: run.id, resumeFromRunId: run.id },
      contextSnapshot: {
        issueId, taskKey: issueId, runTokenCapSourceRunId: run.id,
        wakeReason: "run_token_cap",
        wakeInstruction: "Read the continuation summary. Continue the unfinished work from the saved session. Respect all issue gates.",
      },
    });
  }));
}
