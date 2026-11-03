import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { canRetryStoppedRun, settleBudgetStoppedNativeStartup } from "./cancelled-native-startup.js";
import type { NativeRestartRecoveryClaim } from "./native-runtime/native-restart-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("budget-stopped native startup settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-startup-settlement-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.insert(companies).values({ id: companyId, name: "Settlement", issuePrefix: "SET" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", adapterType: "paperclip_runner" });
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function seed(recovered = true) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Unused bootstrap", status: "todo", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "cancelled",
      finishedAt: new Date(), errorCode: "issue.token_budget_exceeded",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        startupPreparationSettledAt: new Date().toISOString() },
    }).returning();
    const recovery: NativeRestartRecoveryClaim = { kind: "bootstrap_incomplete", runId, leaseOwner: "current-controller",
      controllerGeneration: 2, providerAttempt: 0, restartKind: "hard", recoveryRequestId: null };
    const [coordinator] = await db.insert(nativeRunFinalizations).values({
      runId, companyId, issueId, phase: "observed", failureDetail: { retained: "diagnostic" },
      ...(recovered ? { controllerGeneration: 2, controllerBootId: "controller-boot", controllerPid: process.pid,
        leaseOwner: recovery.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000),
        recoveryHistory: [{ kind: "bootstrap_incomplete", controllerGeneration: 2 }] } : {}),
    }).returning();
    return { run, coordinator, recovery: recovered ? recovery : undefined };
  }

  it.each([false, true])("settles an unused bootstrap and preserves recovery history (recovered=%s)", async recovered => {
    const { run, coordinator, recovery } = await seed(recovered);
    const settled = await settleBudgetStoppedNativeStartup(db, run, recovery);
    expect(settled?.nativePhase).toBe("terminal_failure");
    const [saved] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
    expect(saved).toMatchObject({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
      controllerGeneration: coordinator.controllerGeneration, controllerBootId: coordinator.controllerBootId,
      controllerPid: coordinator.controllerPid, attempt: coordinator.attempt, recoveryHistory: coordinator.recoveryHistory,
      failureDetail: { retained: "diagnostic", budgetStopBeforeProvider: { runId: run.id, companyId, issueId: run.nativeIssueId } } });
    expect(await canRetryStoppedRun(db, settled!)).toBe(true);
    expect(await settleBudgetStoppedNativeStartup(db, run, recovery)).toBeNull();
  });

  it.each(["owner", "generation", "attempt", "run", "company", "expired", "dead_runner"] as const)(
    "rejects a stale or unrelated %s claim without changing the coordinator", async mismatch => {
      const { run, recovery } = await seed();
      const claim: NativeRestartRecoveryClaim = mismatch === "dead_runner"
        ? { ...recovery!, kind: "resume_dead_runner" }
        : { ...recovery! };
      const identity = { id: run.id, companyId };
      if (mismatch === "owner") claim.leaseOwner = "other-controller";
      if (mismatch === "generation") claim.controllerGeneration++;
      if (mismatch === "attempt") claim.providerAttempt++;
      if (mismatch === "run") claim.runId = randomUUID();
      if (mismatch === "company") identity.companyId = randomUUID();
      if (mismatch === "expired") await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) })
        .where(eq(nativeRunFinalizations.runId, run.id));
      const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      expect(await settleBudgetStoppedNativeStartup(db, identity, claim)).toBeNull();
      const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      expect(after).toEqual(before);
      expect(await canRetryStoppedRun(db, run)).toBe(false);
    },
  );

  it.each(["provider_event", "process", "other_error", "successor"] as const)(
    "retains the reconciliation hold for contradictory %s evidence", async evidence => {
      const { run, recovery } = await seed();
      if (evidence === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "provider.event" });
      if (evidence === "process") await db.update(heartbeatRuns).set({ processPid: 12345 }).where(eq(heartbeatRuns.id, run.id));
      if (evidence === "other_error") await db.update(heartbeatRuns).set({ errorCode: "operator_interrupted" }).where(eq(heartbeatRuns.id, run.id));
      if (evidence === "successor") await db.update(nativeRunFinalizations).set({ failureDetail: { successorRunId: randomUUID() } })
        .where(eq(nativeRunFinalizations.runId, run.id));
      expect(await settleBudgetStoppedNativeStartup(db, run, recovery)).toBeNull();
      const [saved] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      expect(saved.phase).toBe("observed");
      expect(saved.leaseOwner).toBe(recovery!.leaseOwner);
    },
  );

  it.each(["generation", "receipt_run", "provider_event", "local_cleanup", "remote_cleanup"] as const)(
    "does not admit Retry after settlement with %s evidence", async evidence => {
      const { run, recovery } = await seed();
      const settled = await settleBudgetStoppedNativeStartup(db, run, recovery);
      expect(await canRetryStoppedRun(db, settled!)).toBe(true);
      const [saved] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      if (evidence === "generation") await db.update(nativeRunFinalizations).set({ controllerGeneration: saved.controllerGeneration + 1 })
        .where(eq(nativeRunFinalizations.runId, run.id));
      if (evidence === "receipt_run") await db.update(nativeRunFinalizations).set({ failureDetail: {
        ...saved.failureDetail, budgetStopBeforeProvider: {
          ...(saved.failureDetail!.budgetStopBeforeProvider as Record<string, unknown>), runId: randomUUID(),
        },
      } }).where(eq(nativeRunFinalizations.runId, run.id));
      if (evidence === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "provider.event" });
      if (evidence === "local_cleanup" || evidence === "remote_cleanup") await db.insert(environmentLeases).values({
        companyId, heartbeatRunId: run.id, issueId: run.nativeIssueId, status: "pending_cleanup",
        provider: evidence === "local_cleanup" ? "local" : "fake", providerLeaseId: randomUUID(),
      });
      expect(await canRetryStoppedRun(db, settled!)).toBe(false);
    },
  );
});
