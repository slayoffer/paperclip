import { spawn } from "node:child_process";
import { once } from "node:events";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, workAssessments } from "@paperclipai/db";
import { type NativeSessionBackend } from "@paperclipai/paperclip-runner";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { claimNativeSessionResumptions, dispatchNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { createPreResultFixture } from "./native-session-resumption-pre-result-fixture.js";

export function registerPreResultCases(mockCaptureRunFailure: ReturnType<typeof vi.fn>) {
  describe("P6-25 pre-result native session recovery", () => {
    const fixture = createPreResultFixture();
    const {
      companyId,
      agentId,
      issueId,
      runId,
      cancelledRunId,
      exhaustedRunId,
      missingCheckpointRunId,
      initialRunId,
      bootstrapRetryRunId,
      observedExpiredRunId,
      observedLivePidRunId,
      persistedProfile,
    } = fixture;
    let db: ReturnType<typeof createDb>;
    beforeAll(() => { db = fixture.db; });
    it("filters durable ownership holds before the bounded resume candidate limit", async () => {
      const heldRunIds = Array.from(
        { length: 26 },
        (_, index) =>
          `79100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      const eligibleRunId = "79100000-0000-4000-8000-000000000099";
      const candidateRunIds = [...heldRunIds, eligibleRunId];
      await db.insert(heartbeatRuns).values(
        candidateRunIds.map((candidateRunId) => ({
          id: candidateRunId,
          companyId,
          agentId,
          nativeIssueId: issueId,
          status: "running",
          runtimeMode: "native",
          nativePhase:
            candidateRunId === eligibleRunId
              ? "retryable_failure"
              : "terminal_failure",
          errorCode:
            candidateRunId === eligibleRunId
              ? null
              : "native_execution_ownership_unverified",
          runnerProfileJson: {
            ...persistedProfile,
            nativeExecutionInput: {
              ...persistedProfile.nativeExecutionInput,
              binding: { runId: candidateRunId },
            },
            sessionCheckpoint: {
              ...persistedProfile.sessionCheckpoint,
              identity: { runId: candidateRunId },
            },
          },
        })),
      );
      await db.insert(nativeRunFinalizations).values(
        candidateRunIds.map((candidateRunId) => ({
          runId: candidateRunId,
          companyId,
          issueId,
          phase: "retryable_failure",
          attempt: 1,
          nextAttemptAt: new Date(0),
          leaseExpiresAt: new Date(0),
        })),
      );
      try {
        expect(
          await claimNativeSessionResumptions({
            db,
            runnerInstanceId: "bounded-reaper",
            runIds: candidateRunIds,
            limit: 1,
          }),
        ).toEqual([
          {
            runId: eligibleRunId,
            leaseOwner: expect.stringContaining("bounded-reaper:resume:"),
          },
        ]);
        const held = await db
          .select()
          .from(nativeRunFinalizations)
          .where(inArray(nativeRunFinalizations.runId, heldRunIds));
        expect(held).toHaveLength(26);
        expect(
          held.every(
            (row) => row.phase === "retryable_failure" && row.leaseOwner === null,
          ),
        ).toBe(true);
      } finally {
        await db
          .delete(nativeRunFinalizations)
          .where(inArray(nativeRunFinalizations.runId, candidateRunIds));
        await db
          .delete(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, candidateRunIds));
      }
    });

    it("wins one database lease for the original result-less run without consulting the flag", async () => {
      const results = await Promise.all([
        claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-a", runIds: [runId] }),
        claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-b", runIds: [runId] }),
      ]);
      expect(results.flat()).toHaveLength(1);
      expect(results.flat()[0]).toMatchObject({ runId });
      await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
        expect.objectContaining({ id: runId, status: "running", runtimeMode: "native" }),
      ]);
      await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
        expect.objectContaining({ runId, phase: "observed", resultId: null, attempt: 1 }),
      ]);
    });

    it("dispatches the persisted run id and lease to the live same-run resume consumer", async () => {
      await db.update(nativeRunFinalizations).set({
        phase: "retryable_failure",
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(0),
      }).where(eq(nativeRunFinalizations.runId, runId));
      const dispatched: Array<{ runId: string; leaseOwner: string }> = [];
      await expect(dispatchNativeSessionResumptions({
        db,
        runnerInstanceId: "heartbeat-reaper",
        runIds: [runId],
        dispatch: (claim) => dispatched.push(claim),
      })).resolves.toHaveLength(1);
      expect(dispatched).toEqual([{ runId, leaseOwner: expect.stringContaining("heartbeat-reaper:resume:") }]);
      await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(8);
      await expect(db.select().from(nativeRunFinalizations)).resolves.toHaveLength(8);
    });

    it("uses provider-neutral checkpoint-free bootstrap retry only when durable evidence proves no session existed", async () => {
      await expect(claimNativeSessionResumptions({
        db,
        runnerInstanceId: "reaper",
        runIds: [bootstrapRetryRunId],
      })).resolves.toEqual([
        { runId: bootstrapRetryRunId, leaseOwner: expect.stringContaining("reaper:resume:") },
      ]);
    });

    it("never claims an expired observed coordinator without explicit retryable failure", async () => {
      const dispatched: Array<{ runId: string; leaseOwner: string }> = [];
      await expect(dispatchNativeSessionResumptions({
        db,
        runnerInstanceId: "replacement-reaper",
        runIds: [observedExpiredRunId],
        dispatch: (claim) => dispatched.push(claim),
      })).resolves.toEqual([]);
      expect(dispatched).toEqual([]);
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, observedExpiredRunId))).resolves.toEqual([
        expect.objectContaining({
          phase: "observed",
          attempt: 2,
          leaseOwner: "prior-native-owner",
          leaseExpiresAt: new Date(0),
        }),
      ]);
    });

    it("blocks ambiguous observed ownership and a live unrelated persisted PID without replacement effects", async () => {
      const unrelatedProcess = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        { stdio: "ignore" },
      );
      await once(unrelatedProcess, "spawn");
      try {
        await db.update(heartbeatRuns).set({
          processPid: unrelatedProcess.pid!,
          processStartedAt: new Date("2026-08-09T04:00:00.000Z"),
        }).where(eq(heartbeatRuns.id, observedLivePidRunId));
        const backendFactory = vi.fn((): NativeSessionBackend => ({
          async descriptor() {
            return {
              kind: "mock",
              name: "unexpected-observed-recovery",
              version: "1",
              capabilities: {
                resume: true,
                typedEvents: true,
                steering: false,
                interruption: true,
                structuredResult: true,
              },
            };
          },
          async openSession() {
            throw new Error("observed ownership must not open a provider session");
          },
          async recoverSession() {
            throw new Error("observed ownership must not recover a provider session");
          },
        }));
        const heartbeat = heartbeatService(db, {
          runtimeEnv: { PAPERCLIP_INSTANCE_ID: "observed-owner-test" },
          nativeSessionBackendFactory: backendFactory,
        });

        const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
        expect(reaped.runIds).not.toContain(observedExpiredRunId);
        expect(reaped.runIds).not.toContain(observedLivePidRunId);
        await heartbeat.drainActiveRunExecutions();

        expect(backendFactory).not.toHaveBeenCalled();
        expect(() => process.kill(unrelatedProcess.pid!, 0)).not.toThrow();
        await expect(db.select().from(heartbeatRuns).where(eq(
          heartbeatRuns.id,
          observedExpiredRunId,
        ))).resolves.toEqual([
          expect.objectContaining({
            status: "running",
            errorCode: "native_execution_ownership_unverified",
          }),
        ]);
        await expect(db.select().from(heartbeatRuns).where(eq(
          heartbeatRuns.id,
          observedLivePidRunId,
        ))).resolves.toEqual([
          expect.objectContaining({
            status: "running",
            processPid: unrelatedProcess.pid,
            errorCode: "native_execution_ownership_unverified",
          }),
        ]);
        for (const observedRunId of [observedExpiredRunId, observedLivePidRunId]) {
          await expect(db.select().from(nativeRunFinalizations).where(eq(
            nativeRunFinalizations.runId,
            observedRunId,
          ))).resolves.toEqual([
            expect.objectContaining({
              phase: "observed",
              attempt: 2,
              leaseOwner: "prior-native-owner",
              leaseExpiresAt: new Date(0),
            }),
          ]);
          await expect(db.select().from(nativeRunResults).where(eq(
            nativeRunResults.runId,
            observedRunId,
          ))).resolves.toHaveLength(0);
          await expect(db.select().from(workAssessments).where(eq(
            workAssessments.runId,
            observedRunId,
          ))).resolves.toHaveLength(0);
        }
      } finally {
        if (
          unrelatedProcess.exitCode === null &&
          unrelatedProcess.signalCode === null
        ) {
          const exited = once(unrelatedProcess, "exit");
          unrelatedProcess.kill("SIGKILL");
          await exited;
        }
      }
    });

    it("does not resume cancelled or exhausted runs and fails closed without a checkpoint", async () => {
      await expect(claimNativeSessionResumptions({
        db,
        runnerInstanceId: "reaper",
        runIds: [cancelledRunId, exhaustedRunId, missingCheckpointRunId],
      })).resolves.toEqual([]);
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, missingCheckpointRunId))).resolves.toEqual([
        expect.objectContaining({ phase: "terminal_failure", failureCode: "native_session_interrupted" }),
      ]);
      await expect(db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
        expect.objectContaining({ cause: "native_session_interrupted", wakePolicy: null }),
      ]);
    });

    it("does not mistake the pre-first-attempt observed coordinator for an orphan", async () => {
      await expect(claimNativeSessionResumptions({
        db,
        runnerInstanceId: "reaper",
        runIds: [initialRunId],
      })).resolves.toEqual([]);
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, initialRunId))).resolves.toEqual([
        expect.objectContaining({ phase: "observed", attempt: 0, failureCode: null }),
      ]);
    });

    it("sends exactly one Sentry event when a sweep resolves a run from running to failed", async () => {
      const freshRunId = "79000000-0000-4000-8000-000000000101";
      await db.insert(heartbeatRuns).values({
        id: freshRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: freshRunId },
          },
        },
        contextSnapshot: { issueId },
      });
      await db.insert(nativeRunFinalizations).values({
        runId: freshRunId,
        companyId,
        issueId,
        phase: "retryable_failure",
        attempt: 1,
      });
      const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

      await claimNativeSessionResumptions({ db, runnerInstanceId: "reaper", runIds: [freshRunId] });
      // The reconciler reports asynchronously; an unrelated database round trip
      // does not guarantee that callback has completed.
      await waitForPendingRunFailureReports();
      expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(1);
      const newCaptures = mockCaptureRunFailure.mock.calls.slice(captureCallsBefore);
      expect(newCaptures[0]?.[0]).toMatchObject({ runId: freshRunId, runStatus: "failed" });
    });

    it("sends no Sentry event when a sweep finds a run that is already failed", async () => {
      const freshRunId = "79000000-0000-4000-8000-000000000102";
      await db.insert(heartbeatRuns).values({
        id: freshRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: freshRunId },
          },
        },
        contextSnapshot: { issueId },
      });
      await db.insert(nativeRunFinalizations).values({
        runId: freshRunId,
        companyId,
        issueId,
        phase: "retryable_failure",
        attempt: 1,
      });
      const captureCallsBefore = mockCaptureRunFailure.mock.calls.length;

      await claimNativeSessionResumptions({ db, runnerInstanceId: "reaper", runIds: [freshRunId] });
      await waitForPendingRunFailureReports();

      expect(mockCaptureRunFailure.mock.calls.slice(captureCallsBefore)).toHaveLength(0);
    });
  });
}
