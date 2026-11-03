import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, budgetReservations, issueRecoveryActions, environments, environmentLeases } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as nativeRuntime from "../services/native-runtime/index.js";
import { canRetryStoppedRun } from "../services/cancelled-native-startup.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../services/execution-blocker.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readProcessStartedAt } from "../services/hot-restart.js";
import { NativeRunnerOwnershipUnverifiedError } from "../services/native-runtime/native-runner-ownership.js";

import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";

import { directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { nativeWorkspaceSyncInternals } from "../services/native-runtime/native-workspace-sync.js";
import { nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping native issue-budget tests: ${support.reason}`);

describeDatabase("issue budget during native restart recovery", () => {
  it.each(["local", "remote", "bootstrap", "dead", "fresh", "continuation", "dead_unreserved"] as const)("reconciles %s ownership above the issue budget", async runnerKind => {
    const fresh = runnerKind === "fresh" || runnerKind === "continuation";
    const historical = runnerKind === "dead" || runnerKind === "dead_unreserved";
    const database = await startEmbeddedPostgresTestDatabase("issue-budget-native-recovery-");
    const db = createDb(database.connectionString);
    const originalHome = process.env.PAPERCLIP_HOME;
    const budgetKeys = ["PAPERCLIP_ISSUE_TOKEN_BUDGET", "PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE"];
    const savedBudget = Object.fromEntries(budgetKeys.map(key => [key, process.env[key]]));
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET = "100";
    process.env.PAPERCLIP_ISSUE_TOKEN_BUDGET_SINCE = new Date(Date.now() - 3_600_000).toISOString();
    const isolated = createIsolatedTestHome();
    const home = isolated.home;
    process.env.PAPERCLIP_HOME = home;
    const runner = runnerKind === "local"
      ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" })
      : null;
    // The provider boundary reports uncertain ownership. All restart classification,
    // preparation, budget admission, and durable lifecycle writes remain real.
    const dispatch = vi.spyOn(nativeRuntime, "executePaperclipNativeSession").mockImplementation(async () => {
      throw new NativeRunnerOwnershipUnverifiedError();
    });
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    try {
      if (runner) await once(runner, "spawn");
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const sessionId = randomUUID();
      const startedAt = runner ? await readProcessStartedAt(runner.pid!) : null;
      if (runner) expect(startedAt).toBeTruthy();
      const lockedAt = new Date();
      const environmentId = randomUUID();
      const leaseId = randomUUID();
      const profile: Record<string, unknown> = ["bootstrap", "fresh", "continuation"].includes(runnerKind) ? {} : {
        sessionCheckpoint: {
          identity: { companyId, issueId, runId, agentId, sessionId },
          providerSessionId: "existing-session",
        },
      };
      if (runnerKind === "remote") {
        const baseline = { exclude: [], entries: new Map() };
        profile.nativeWorkspaceSync = await nativeWorkspaceSyncInternals.writeDescriptor({
          schema: "paperclip.native-workspace-sync/v1", state: "prepared",
          binding: { companyId, runId, workspaceId: runId, leaseId, providerLeaseId: "existing-provider-lease",
            localCwd: home, remoteCwd: home },
          baselineSha256: directorySnapshotSha256(baseline), baseline: serializeDirectorySnapshot(baseline),
          gitSnapshot: null, seed: null, createdAt: new Date().toISOString(), finalizedAt: null,
          finalHostSha256: null, resourceDisposition: "keep_running",
        });
        await db.insert(environments).values({ id: environmentId, name: "Retained test sandbox",
          driver: "sandbox", config: { provider: "fake", image: "fake:test" } });
      }
      await db.insert(companies).values({ id: companyId, name: "Budget recovery", issuePrefix: "BUDGET", defaultResponsibleUserId: userId });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
        membershipRole: "owner", status: "active" });
      await db.insert(agents).values({
        id: agentId, companyId, name: "Recovery", role: "engineer",
        defaultEnvironmentId: runnerKind === "remote" ? environmentId : null,
        adapterType: "paperclip_runner", adapterConfig: { provider: "codex", cwd: home },
      });
      await db.insert(issues).values({
        id: issueId, companyId, title: "Existing work", status: "in_progress", assigneeAgentId: agentId,
        executionAgentNameKey: "recovery", executionLockedAt: lockedAt, responsibleUserId: userId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, status: fresh ? "queued" : "running", runtimeMode: "native",
        nativeIssueId: issueId, nativeSessionId: sessionId, invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId }, startedAt: fresh ? null : lockedAt, responsibleUserId: userId,
        usageJson: {},
        processPid: runner?.pid ?? null, processGroupId: runner?.pid ?? null,
        processStartedAt: startedAt ? new Date(startedAt) : null, runnerProfileJson: profile,
      });
      if (runnerKind === "remote") await db.insert(environmentLeases).values({
        id: leaseId, environmentId, companyId, heartbeatRunId: runId, issueId,
        provider: "fake", providerLeaseId: "existing-provider-lease", leasePolicy: "retain_on_failure",
        metadata: { agentId, remoteCwd: home },
      });
      const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "assignment",
        issueId, contextSnapshot: { issueId }, usageJson: { inputTokens: 100 }, finishedAt: new Date(),
        costAccountedAt: new Date(), createdAt: new Date(lockedAt.getTime() - 1_000),
        ...(runnerKind === "continuation" ? { runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: sessionId } : {}),
      }).returning();
      if (runnerKind === "bootstrap" || runnerKind === "dead") {
        await db.insert(budgetReservations).values({ companyId, agentId, runId, amountCents: "10", state: "held" });
        await db.update(heartbeatRuns).set({ costAccountingPending: true,
          usageJson: { accountingReceiptReady: false, ledgerScope: { issueId, projectId: null } },
        }).where(eq(heartbeatRuns.id, runId));
      }
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      if (!["bootstrap", "fresh"].includes(runnerKind)) {
        const [initial] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await prepareNativeHeartbeatRun({ db, run: initial,
          issue: { id: issueId, title: "Existing work", description: null }, environmentLeaseId: runnerKind === "remote" ? leaseId : randomUUID() });
        const [prepared] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const [contract] = await db.select().from(completionContracts)
          .where(eq(completionContracts.id, prepared.completionContractId!));
        const execution = buildNativeExecutionInput({ companyId, agentId, runId,
          issue: { id: issueId, identifier: null, title: "Existing work", description: null, workMode: "standard" },
          taskPrompt: "Complete existing work", normalizedSessionId: sessionId,
          runtimeContext: nativeRuntimeContextFixture(),
          workspace: { id: runId, cwd: home, repoUrl: null, repoRef: null, branchName: null },
          completionContract: { id: contract.id, sha256: contract.canonicalSha256,
            schemaVersion: contract.schemaVersion, contract: contract.contractJson as never } });
        if (runnerKind === "continuation") {
          const predecessorInput = structuredClone(execution);
          predecessorInput.binding.runId = source.id;
          predecessorInput.binding.executionWorkspaceId = source.id;
          await db.update(heartbeatRuns).set({ runnerProfileJson: {
            nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local"),
            nativeExecutionInput: predecessorInput,
            sessionCheckpoint: { backendKind: "runner", driverKind: "codex_app_server",
              sessionId: "completed-predecessor-session", providerSessionId: "completed-predecessor-session",
              identity: { companyId, agentId, issueId, runId: source.id, sessionId },
              semanticResult: { schema: "paperclip.run-result.v1", reportedWorkDisposition: "done", summary: "Completed predecessor" },
            },
          } }).where(eq(heartbeatRuns.id, source.id));
        }
        await db.update(heartbeatRuns).set({ runnerProfileJson: {
          ...prepared.runnerProfileJson, ...profile, nativeExecutionInput: execution,
        } }).where(eq(heartbeatRuns.id, runId));
      }
      if (!fresh) await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      // The fake sandbox executes only preparation commands inside this fixture.
      // Retained lease validation and workspace descriptor reads remain real.
      heartbeat = heartbeatService(db, { environmentRuntime: {
        ...environmentRuntimeService(db),
        execute: async input => ({ exitCode: 0, stderr: "", signal: null, timedOut: false,
          stdout: execFileSync(input.command, input.args ?? [], { cwd: home, input: input.stdin,
            encoding: "utf8", env: { ...process.env, ...input.env } }),
        }),
      } });
      const recovery = fresh ? null : await heartbeat.recoverNativeRunsAfterRestart();
      if (fresh) await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      const kind = runnerKind === "remote" ? "reattach_remote_runner"
        : runnerKind === "local" ? "reattach_existing_runner"
          : runnerKind === "bootstrap" ? "bootstrap_incomplete" : "resume_dead_runner";
      if (recovery) expect(recovery.claims).toEqual([expect.objectContaining({ kind, runId })]);
      await heartbeat.drainActiveRunExecutions();
      const reattaching = runnerKind === "local" || runnerKind === "remote";
      expect(dispatch).toHaveBeenCalledTimes(reattaching ? 1 : 0);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      if (reattaching) {
        expect(run).toMatchObject({ status: "running", startedAt: lockedAt, processPid: runner?.pid ?? null });
        expect(issue).toMatchObject({ executionRunId: runId, executionAgentNameKey: "recovery", executionLockedAt: lockedAt });
        if (runner) expect(runner.exitCode).toBeNull();
      } else {
        expect(run).toMatchObject({ status: "cancelled", errorCode: "issue.token_budget_exceeded" });
        expect(issue.executionRunId).toBeNull();
        const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
        if (runnerKind === "continuation") {
          expect(run.runnerProfileJson?.sessionCheckpoint).toMatchObject({
            providerSessionId: "completed-predecessor-session", identity: { runId },
          });
        }
        if (historical) {
          expect(issue.status).toBe("blocked");
          expect(actions.some(action => action.cause === "native_continuation_requires_reconciliation")).toBe(true);
          expect(run.resultJson?.executionRecovery).not.toMatchObject({ providerWorkStarted: false });
          expect.soft(run.usageJson?.accountingProviderWorkStarted).not.toBe(false);
          expect.soft(run.costAccountedAt).toBeNull();
          expect.soft((await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId)))[0].state).toBe("held");
        } else {
          expect.soft(await canRetryStoppedRun(db, run)).toBe(true);
          expect.soft(await hasPendingRunCleanup(db, companyId, runId)).toBe(false);
          expect.soft(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
          expect.soft(issue.status).toBe("in_progress");
          expect.soft(actions.filter(action => action.cause === "native_continuation_requires_reconciliation")).toEqual([]);
          expect.soft(run.resultJson?.executionRecovery).toMatchObject({ kind: "bootstrap", providerWorkStarted: false });
          expect.soft(run.costAccountedAt).toBeInstanceOf(Date);
          expect.soft(run.costAccountingPending).toBe(false);
          const reservations = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId));
          expect(reservations).toHaveLength(1);
          expect.soft(reservations[0].state).toBe("released");
        }
      }
    } finally {
      await heartbeat?.drainActiveRunExecutions();
      dispatch.mockRestore();
      for (const [key, value] of Object.entries(savedBudget)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (runner && runner.exitCode === null) {
        const exited = once(runner, "exit");
        runner.kill("SIGTERM");
        await exited;
      }
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      await db.$client.end({ timeout: 0 });
      await database.cleanup();
      isolated.cleanup();
    }
  }, 60_000);
});
