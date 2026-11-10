import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults,
  statusDecisions, workAssessments } from "@paperclipai/db";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("native cancellation resolution race", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-cancellation-race-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it("commits cancellation without replacing a concurrent interaction resolution", async () => {
    const companyId = randomUUID();
    const contractId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native cancellation race", issuePrefix: "NCR" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Native", adapterType: "process", status: "running" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Cancel", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      nativeIssueId: issue.id, status: "running", runtimeMode: "native", completionContractId: contractId,
      completionContractSha256: "fixture-contract", contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: issue.id,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "fixture", criteria: [] }, canonicalSha256: "fixture-contract",
      createdByActorType: "system", createdByActorId: "fixture" });
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId: issue.id, runId: run.id,
      completionContractId: contractId, serverFingerprint: "fixture-result", schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "fixture-result" }).returning();
    const [assessment] = await db.insert(workAssessments).values({ companyId, issueId: issue.id, runId: run.id,
      contractId, resultId: result.id, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: {}, inputDigest: "fixture-assessment" }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
      phase: "assessing", resultId: result.id, assessmentId: assessment.id });
    const cards = await db.insert(issueThreadInteractions).values([0, 1].map(() => ({ companyId,
      issueId: issue.id, kind: "request_confirmation", continuationPolicy: "none",
      payload: { version: 1 as const, prompt: "Continue?" } }))).returning();
    const [winner, pending] = cards;
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    let writerPid = 0;
    const concurrentResolution = db.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      writerPid = pid.pid;
      await tx.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(),
        resolvedByUserId: "concurrent-user", resolvedVia: "user_session", resolvedViaKeyId: null })
        .where(eq(issueThreadInteractions.id, winner.id));
      locked();
      await releaseGate;
    });
    await lockedGate;
    const commit = commitNativeStatusDecision({ db, companyId, issueId: issue.id, runId: run.id,
      assessmentId: assessment.id, priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "preserve",
        toStatus: "in_progress", reasonCode: "fixture_cancellation", unblockDescriptor: null,
        effects: [{ kind: "cancel_continuations" }] },
    }).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try {
      // Wait until the real cancellation UPDATE reaches the competing row lock.
      await expect.poll(async () => {
        const rows = await db.$client`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${writerPid} = ANY(pg_blocking_pids(pid))
            AND query LIKE '%update "issue_thread_interactions"%'`;
        return rows.length;
      }, { timeout: 10_000, interval: 10 }).toBe(1);
    } finally { release(); }
    await concurrentResolution;
    const outcome = await commit;
    expect(outcome.error).toBeNull();
    const [savedWinner] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, winner.id));
    expect(savedWinner).toMatchObject({ status: "accepted", resolvedVia: "user_session",
      resolvedViaKeyId: null, resolvedByUserId: "concurrent-user" });
    const [savedPending] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.id));
    expect(savedPending).toMatchObject({ status: "cancelled", resolvedVia: "system", resolvedViaKeyId: null });
    const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(savedRun.status).toBe("cancelled");
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issue.id));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].applicationState).toBe("applied");
  }, 30_000);
});
