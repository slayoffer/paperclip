import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, statusDecisionEffects, statusDecisions, workAssessments } from "@paperclipai/db";
import { type NativeExecutionInput, type NativeSession, type NativeSessionBackend } from "@paperclipai/paperclip-runner";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { createPersistedRecoveryFixture } from "./native-session-resumption-persisted-fixture.js";

export function registerPersistedRecoveryCases(legacyAdapterExecute: ReturnType<typeof vi.fn>) {
  describe.each(["unchanged", "newer_active", "stale_idle"] as const)(
    "P6-25 persisted reaper-to-finalization recovery (%s)",
    (variant) => {
      const fixture = createPersistedRecoveryFixture(variant);
      const {
        state,
        newerRequest,
        companyId,
        agentId,
        projectId,
        projectWorkspaceId,
        issueId,
        freshIssueId,
        runId,
        contractId,
        sessionId,
        runnerInstanceId,
        newerCommentId,
        newerWakeKey,
        contract,
        execution,
        checkpoint,
        providerTerminalEvent,
        result,
        terminal,
        backend,
        recoverSession,
        openSession,
        startTurn,
        close,
        newerExecutionWorkspaceId,
      } = fixture;
      it("preserves the old provider contract and admits newer direction only in a separate turn", async () => {
        const { db } = fixture;
        legacyAdapterExecute.mockClear();
        state.staleProviderProcess = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" },
        );
        await once(state.staleProviderProcess, "spawn");
        expect(state.staleProviderProcess.pid).toEqual(expect.any(Number));
        await db
          .update(heartbeatRuns)
          .set({
            processPid: state.staleProviderProcess.pid!,
            processStartedAt: new Date("2026-08-09T04:00:00.000Z"),
          })
          .where(eq(heartbeatRuns.id, runId));
        const factoryInputs: NativeExecutionInput[] = [];
        const freshStartTurn = vi.fn<NativeSession["startTurn"]>();
        const freshBackend = (
          executionInput: NativeExecutionInput,
        ): NativeSessionBackend => {
          const freshRunId = executionInput.binding.runId;
          const freshTurnId = `new-direction:${freshRunId}`;
          const freshIdentity = {
            ...checkpoint.identity,
            runId: freshRunId,
            sessionId: executionInput.session.normalizedSessionId,
          };
          let releaseStart!: () => void;
          const started = new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
          let freshResult = structuredClone(result);
          const session: NativeSession = {
            identity: () => freshIdentity,
            capabilities: async () => ({
              resume: true,
              typedEvents: true,
              steering: false,
              interruption: true,
              structuredResult: true,
            }),
            async *events() {
              await started;
              const [freshRun] = await db
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, freshRunId));
              yield {
                ...providerTerminalEvent,
                sourceEventId: `${freshRun.runnerInstanceId}:fresh-terminal`,
                sourceInstanceId: freshRun.runnerInstanceId!,
                runId: freshRunId,
                normalizedSessionId: freshIdentity.sessionId,
                turnId: freshTurnId,
              };
            },
            async startTurn(input) {
              freshStartTurn(input);
              const delivered = JSON.parse(input.message.text);
              expect(delivered.task.prompt).toContain(
                "Verify the newest user instruction",
              );
              const currentContract =
                delivered.completionContract as typeof contract;
              freshResult.completionClaim.contractRevision =
                currentContract.revision;
              freshResult.completionClaim.criteria = currentContract.criteria.map(
                (criterion) => ({
                  ...freshResult.completionClaim.criteria[0]!,
                  criterionId: criterion.id,
                }),
              );
              freshResult.summary =
                "Completed the separately delivered newer instruction.";
              releaseStart();
              return { turnId: freshTurnId };
            },
            async result() {
              return { result: freshResult, terminal, turnId: freshTurnId };
            },
            async snapshot() {
              return {
                ...checkpoint,
                identity: freshIdentity,
                providerSessionId: `fresh:${freshRunId}`,
                activeTurnId: null,
                cursor: "0",
              };
            },
            async close() {},
          };
          return {
            async descriptor() {
              return {
                ...(await backend.descriptor()),
                runtimeContextCapabilities: {
                  instructions: "native",
                  skills: "native",
                  mcp: "native",
                },
              };
            },
            async openSession(input) {
              expect(input.identity).toEqual(freshIdentity);
              return session;
            },
            async recoverSession() {
              throw new Error(
                "newer user cause must not reuse the prior active turn",
              );
            },
          };
        };
        const backendFactory = vi.fn((input: NativeExecutionInput) => {
          factoryInputs.push(structuredClone(input));
          return input.binding.runId === runId ? backend : freshBackend(input);
        });
        const heartbeat = heartbeatService(db, {
          runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
          nativeSessionBackendFactory: backendFactory,
        });
        if (newerRequest) {
          // Restore the independently admitted receipt that was deferred while the
          // original provider was running, before this simulated process loss.
          await db.insert(agentWakeupRequests).values({
            companyId,
            agentId,
            status: "deferred_issue_execution",
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            idempotencyKey: newerWakeKey,
            requestedByActorType: "user",
            requestedByActorId: "responsible-user",
            payload: {
              issueId,
              commentId: newerCommentId,
              _paperclipWakeContext: {
                issueId,
                taskId: issueId,
                commentId: newerCommentId,
                wakeCommentIds: [newerCommentId],
                skipIssueComment: true,
              },
            },
          });
          const [receipt] = await db
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.idempotencyKey, newerWakeKey));
          expect(receipt.status).toBe("deferred_issue_execution");
        }

        await expect(
          heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 }),
        ).resolves.not.toContain(runId);
        await heartbeat.drainActiveRunExecutions();

        expect(backendFactory).not.toHaveBeenCalled();
        expect(recoverSession).not.toHaveBeenCalled();
        expect(() => process.kill(state.staleProviderProcess!.pid!, 0)).not.toThrow();
        await expect(
          db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)),
        ).resolves.toEqual([
          expect.objectContaining({
            id: runId,
            status: "running",
            processPid: state.staleProviderProcess.pid,
            errorCode: "native_execution_ownership_unverified",
          }),
        ]);
        await expect(
          db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, runId)),
        ).resolves.toEqual([
          expect.objectContaining({
            phase: "retryable_failure",
            attempt: 1,
            leaseOwner: null,
          }),
        ]);

        const unrelatedProcessExit = once(state.staleProviderProcess, "exit");
        state.staleProviderProcess.kill("SIGKILL");
        await unrelatedProcessExit;
        await db
          .update(nativeRunFinalizations)
          .set({
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(eq(nativeRunFinalizations.runId, runId));

        await expect(
          heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 }),
        ).resolves.not.toContain(runId);
        await heartbeat.drainActiveRunExecutions();

        if (newerRequest) {
          await drainHeartbeatRunsToQuiescence(db, heartbeat);
          const original = factoryInputs.find(
            (input) => input.binding.runId === runId,
          );
          expect(original?.completionContract).toEqual(
            execution.completionContract,
          );
          expect(original?.task.prompt).toBe(execution.task.title);
          expect(startTurn).not.toHaveBeenCalled();
          const [accepted] = await db
            .select()
            .from(nativeRunResults)
            .where(eq(nativeRunResults.runId, runId));
          expect(accepted?.completionContractId).toBe(contractId);
          const [receipt] = await db
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.idempotencyKey, newerWakeKey));
          expect(receipt.payload).toMatchObject({ commentId: newerCommentId });
          expect(receipt.status).toBe("completed");
          expect(receipt.runId).not.toBe(runId);
          expect(freshStartTurn).toHaveBeenCalledOnce();
          const [freshRun] = await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, receipt.runId!));
          expect(freshRun).toMatchObject({
            status: "succeeded",
            nativePhase: "committed",
          });
          expect(
            await db
              .select()
              .from(nativeRunResults)
              .where(eq(nativeRunResults.runId, receipt.runId!)),
          ).toHaveLength(1);
          expect(
            factoryInputs.filter((input) => input.binding.runId === runId),
          ).toHaveLength(1);
          await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
          await drainHeartbeatRunsToQuiescence(db, heartbeat);
          expect(freshStartTurn).toHaveBeenCalledOnce();
          expect(
            await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.companyId, companyId)),
          ).toHaveLength(2);
          return;
        }
        const recoveryState = {
          run: await db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId)),
          coordinator: await db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, runId)),
        };
        expect(
          backendFactory.mock.calls.length,
          JSON.stringify(recoveryState),
        ).toBe(1);
        expect(recoverSession).toHaveBeenCalledOnce();
        expect(openSession).not.toHaveBeenCalled();
        expect(startTurn).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(legacyAdapterExecute).not.toHaveBeenCalled();

        await expect(
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.companyId, companyId)),
        ).resolves.toEqual([
          expect.objectContaining({
            id: runId,
            runtimeMode: "native",
            status: "succeeded",
            nativePhase: "committed",
            processPid: null,
            processGroupId: null,
            processStartedAt: null,
          }),
        ]);
        await expect(
          db
            .select()
            .from(nativeRunResults)
            .where(eq(nativeRunResults.runId, runId)),
        ).resolves.toHaveLength(1);
        await expect(
          db
            .select()
            .from(workAssessments)
            .where(eq(workAssessments.runId, runId)),
        ).resolves.toHaveLength(1);
        const decisions = await db
          .select()
          .from(statusDecisions)
          .where(eq(statusDecisions.issueId, issueId));
        expect(decisions).toEqual([
          expect.objectContaining({
            reasonCode: "completion_contract_satisfied",
            toStatus: "done",
            applicationState: "applied",
          }),
        ]);
        const effects = await db
          .select()
          .from(statusDecisionEffects)
          .where(eq(statusDecisionEffects.issueId, issueId));
        expect(new Set(effects.map((effect) => effect.decisionId))).toEqual(
          new Set([decisions[0]!.id]),
        );
        expect(effects.map((effect) => effect.effectKind).sort()).toEqual([
          "issue_status_projection",
          "release_checkout",
        ]);
        await expect(
          db.select().from(issues).where(eq(issues.id, issueId)),
        ).resolves.toEqual([
          expect.objectContaining({
            status: "done",
            statusVersion: 1,
            lastStatusDecisionId: decisions[0]!.id,
            executionWorkspaceId: newerExecutionWorkspaceId,
          }),
        ]);
        await expect(
          db
            .select()
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.companyId, companyId)),
        ).resolves.toHaveLength(2);
        await expect(
          db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, runId)),
        ).resolves.toEqual([
          expect.objectContaining({
            phase: "committed",
            resultId: expect.any(String),
            assessmentId: expect.any(String),
            decisionId: decisions[0]!.id,
          }),
        ]);
        await expect(
          db
            .select()
            .from(heartbeatRunEvents)
            .where(eq(heartbeatRunEvents.runId, runId)),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ eventType: "turn.completed" }),
            expect.objectContaining({ eventType: "run.result.accepted" }),
            expect.objectContaining({ eventType: "run.terminal" }),
          ]),
        );
        await expect(
          db.select().from(activityLog).where(eq(activityLog.entityId, issueId)),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: "issue.updated" }),
          ]),
        );

        await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
        await heartbeat.drainActiveRunExecutions();
        expect(backendFactory).toHaveBeenCalledOnce();
        await expect(
          db
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.companyId, companyId)),
        ).resolves.toHaveLength(1);
        await expect(
          db
            .select()
            .from(nativeRunResults)
            .where(eq(nativeRunResults.runId, runId)),
        ).resolves.toHaveLength(1);
        await expect(
          db
            .select()
            .from(workAssessments)
            .where(eq(workAssessments.runId, runId)),
        ).resolves.toHaveLength(1);
        await expect(
          db
            .select()
            .from(statusDecisions)
            .where(eq(statusDecisions.issueId, issueId)),
        ).resolves.toHaveLength(1);

        // The persisted Paperclip Runner run above remains recoverable while the
        // flag is off. Switching the agent back to a direct adapter now proves a
        // fresh run ignores the stale native profile and stays on the legacy path.
        await db
          .update(agents)
          .set({ adapterType: "codex_local" })
          .where(eq(agents.id, agentId));
        await db.insert(issues).values({
          id: freshIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          issueNumber: 2,
          identifier: "NRR-2",
          title: "Start only after the native kill switch is off",
          status: "in_progress",
          assigneeAgentId: agentId,
          workMode: "standard",
        });
        const directExecute = legacyAdapterExecute.getMockImplementation()!;
        legacyAdapterExecute.mockImplementationOnce(async () => {
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, freshIssueId));
          return directExecute();
        });
        const fresh = await heartbeat.wakeup(agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: { issueId: freshIssueId },
          contextSnapshot: {
            issueId: freshIssueId,
            taskId: freshIssueId,
            skipIssueComment: true,
          },
        });
        expect(fresh).not.toBeNull();
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        expect(legacyAdapterExecute).toHaveBeenCalledOnce();
        await expect(
          db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fresh!.id)),
        ).resolves.toEqual([
          expect.objectContaining({
            agentId,
            runtimeMode: "legacy",
            runtimeModeReason: "direct_adapter",
            status: "succeeded",
          }),
        ]);
        await expect(
          db
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, fresh!.id)),
        ).resolves.toHaveLength(0);
        await expect(
          db
            .select()
            .from(nativeRunResults)
            .where(eq(nativeRunResults.runId, fresh!.id)),
        ).resolves.toHaveLength(0);
        await expect(
          db
            .select({ runtimeConfig: agents.runtimeConfig })
            .from(agents)
            .where(eq(agents.id, agentId)),
        ).resolves.toEqual([
          expect.objectContaining({
            runtimeConfig: expect.objectContaining({
              nativeRunner: {
                mode: "native",
                backend: "codex_app_server",
                protocolVersion: 1,
              },
            }),
          }),
        ]);
      }, 30_000);
    },
  );
}
