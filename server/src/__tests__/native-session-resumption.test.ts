import { readFile } from "node:fs/promises";
import { enableRunFailureReporting } from "./helpers/run-failure-reporting.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agentTaskSessions,
  agents,
  companies,
  authUsers,
  companyMemberships,
  completionContracts,
  createDb,
  closeRegisteredClients,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueComments,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  projectWorkspaces,
  projects,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  type NativeExecutionInputV1,
  type NativeExecutionInput,
  type NativeSession,
  type NativeSessionBackend,
  type PersistedNativeSession,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import {
  claimNativeSessionResumptions,
  dispatchNativeSessionResumptions,
} from "../services/native-runtime/native-finalization-reconciler.js";

const legacyAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "Fresh flag-off run completed through legacy.",
  resultJson: { summary: "fresh legacy after persisted native recovery" },
  provider: "test",
  model: "legacy-test",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      execute: legacyAdapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return { ...actual, captureRunFailure: mockCaptureRunFailure };
});

import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { issueService } from "../services/issues.js";
import * as heartbeatWorkspaces from "../services/heartbeat/workspaces.js";
import { heartbeatService } from "../services/heartbeat.js";
import { persistHeartbeatRunProcessMetadata } from "../services/heartbeat/run-lifecycle.js";
import { instanceSettingsService } from "../services/instance-settings.js";

import { registerPreResultCases } from "./native-session-resumption-pre-result-cases.js";
import { registerPersistedRecoveryCases } from "./native-session-resumption-persisted-cases.js";

registerPreResultCases(mockCaptureRunFailure);
registerPersistedRecoveryCases(legacyAdapterExecute);

describe("goal-less native task-session publication", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-native-pointer-");
      db = createDb(database.connectionString);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await closeRegisteredClients(process.env.PAPERCLIP_TEST_DATABASE_URL ?? database!.connectionString, { scope: "database" });
    await database?.cleanup();
  });

  it.each(["retained", "reset", "fresh", "migrated"] as const)("publishes the completed task session before provider cleanup and resumes an ordinary comment (%s)", async mode => {
    const home = createIsolatedTestHome();
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home.home;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const issuePrefix = `NPT${companyId.slice(0, 6).toUpperCase()}`;
    const projectId = randomUUID(), projectWorkspaceId = randomUUID(), workProductId = randomUUID();
    let providerSessionId: string | undefined;
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const evidenceRef = `work_product:${workProductId}`;
    const inputs: NativeExecutionInput[] = [];
    const configs: Record<string, unknown>[] = [];
    const buildMetadata = heartbeatWorkspaces.buildEffectiveRunSessionConfigMetadata;
    const configuration = vi.spyOn(heartbeatWorkspaces, "buildEffectiveRunSessionConfigMetadata").mockImplementation(input => {
      configs.push(structuredClone(input.effectiveAdapterConfig));
      return buildMetadata(input);
    });
    const openSession = vi.fn(), recoverSession = vi.fn(), startTurn = vi.fn();
    let releaseClose!: () => void, notifyClose!: () => void;
    const closeHeld = new Promise<void>(resolve => { releaseClose = resolve; });
    const closeEntered = new Promise<void>(resolve => { notifyClose = resolve; });
    let firstRunId: string | undefined;
    const backendFactory = (execution: NativeExecutionInput): NativeSessionBackend => {
      inputs.push(structuredClone(execution));
      firstRunId ??= execution.binding.runId;
      const currentRunId = execution.binding.runId;
      const currentProviderSessionId = `provider-${execution.session.normalizedSessionId}`;
      providerSessionId ??= currentProviderSessionId;
      const turnId = `turn-${currentRunId}`;
      const identity = { companyId, agentId, issueId, runId: currentRunId, sessionId: execution.session.normalizedSessionId! };
      const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
      result.completionClaim.contractRevision = execution.completionContract.contract.revision;
      result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
        ...result.completionClaim.criteria[0]!, criterionId: criterion.id, evidenceRefs: [evidenceRef],
      }));
      result.evidence = [{ kind: "work_product", ref: evidenceRef }];
      result.verification[0]!.artifactRef = evidenceRef;
      let started!: () => void;
      const turnStarted = new Promise<void>(resolve => { started = resolve; });
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
        async *events() {
          await turnStarted;
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, currentRunId));
          yield { schema: "paperclip.prp.event.v1", sourceEventId: `${currentRunId}:terminal`, sourceSeq: 1,
            sourceInstanceId: run.runnerInstanceId!, sourceKind: "runner", runId: currentRunId,
            normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1,
            priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
        },
        async startTurn(input) { startTurn(input); started(); return { turnId }; },
        async result() { await turnStarted; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
        async snapshot() { return { backendKind: "mock", sessionId: "driver-retained", identity, providerSessionId: currentProviderSessionId,
          activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
        async close() { if (currentRunId === firstRunId) { notifyClose(); await closeHeld; } },
      };
      return {
        async descriptor() { return { kind: "mock", name: "task-pointer-backend", version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession(input) { openSession(input); return session; },
        async recoverSession(snapshot) { recoverSession(snapshot); expect(snapshot.providerSessionId).toBe(currentProviderSessionId);
          return { recovered: true, session }; },
      };
    };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: backendFactory });
    try {
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
      await db.insert(authUsers).values({ id: "pointer-user", name: "Pointer user", email: "pointer@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companies).values({ id: companyId, name: "Native pointer", issuePrefix, status: "active", defaultResponsibleUserId: "pointer-user" });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "pointer-user", status: "active", membershipRole: "member" });
      await db.insert(projects).values({ id: projectId, companyId, name: "Pointer project", status: "active" });
      await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Pointer workspace", cwd: repoRoot, isPrimary: true });
      await db.insert(agents).values({ id: agentId, companyId, name: "Pointer agent", adapterType: "paperclip_runner", status: "active",
        // This scenario is per-turn publication: each run closes its session.
        // An unset lifecycle now resolves to warm for local Codex.
        adapterConfig: { provider: "codex", lifecycleMode: "per_turn", workspaceStrategy: { type: "project_primary" } },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
      await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId, issueNumber: 1,
        identifier: `${issuePrefix}-1`, title: "Deliver the saved artifact", status: "in_progress", assigneeAgentId: agentId, workMode: "standard",
        // Declare the shared mode up front, as the normal profile does. The
        // first workspace otherwise materializes this setting and legitimately
        // changes the effective adapter strategy before the next admission.
        executionWorkspaceSettings: { mode: "shared_workspace" } });
      await db.insert(issueWorkProducts).values({ id: workProductId, companyId, issueId, type: "artifact", provider: "paperclip",
        title: "Saved artifact", status: "ready_for_review", reviewState: "approved" });
      const first = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "pointer-user", payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true } });
      expect(first).not.toBeNull();
      await closeEntered;
      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, first!.id))).toHaveLength(1);
      expect(persisted.runnerProfileJson?.sessionCheckpoint).toMatchObject({ identity: { sessionId: persisted.nativeSessionId },
        providerSessionId, semanticResult: expect.any(Object), terminal: { runTerminalState: "succeeded" } });
      const pointer = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
      expect(pointer).toEqual([expect.objectContaining({ lastRunId: first!.id,
        sessionParamsJson: expect.objectContaining({ sessionId: persisted.nativeSessionId }), sessionDisplayId: providerSessionId })]);
      if (mode === "reset") {
        expect(await heartbeat.resetRuntimeSession(agentId, { taskKey: issueId })).toMatchObject({ clearedTaskSessions: 1 });
        expect(await heartbeat.listTaskSessions(agentId)).toEqual([]);
      }
      releaseClose();
      await heartbeat.drainActiveRunExecutions();
      if (mode === "reset") expect(await heartbeat.listTaskSessions(agentId)).toEqual([]);
      if (mode === "migrated") {
        // Migration 0443 clears the stored per_turn creation default between
        // turns. The saved task session and its provider history must survive.
        const migration = await readFile(new URL("../../../packages/db/src/migrations/0443_native_warm_follow_up_default.sql", import.meta.url), "utf8");
        await db.execute(sql.raw(migration));
        const [migratedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
        expect(migratedAgent.adapterConfig).not.toHaveProperty("lifecycleMode");
        const audit = (await db.select().from(activityLog).where(eq(activityLog.entityId, agentId)))
          .filter(row => row.actorId === "migration:native-warm-follow-up-default");
        expect(audit).toEqual([expect.objectContaining({ action: "agent.updated" })]);
      }
      // The normal comment route reopens a completed task before its user wake.
      // Use those public services; a raw comment on a still-done task is stale.
      const issuesSvc = issueService(db);
      await issuesSvc.update(issueId, { status: "todo", actorUserId: "pointer-user" });
      const comment = await issuesSvc.addComment(issueId, "Continue using the saved artifact.", { userId: "pointer-user" });
      const second = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment",
        requestedByActorType: "user", requestedByActorId: "pointer-user", payload: { issueId, commentId: comment.id, mutation: "comment", reopenedFrom: "done" },
        contextSnapshot: { issueId, taskId: issueId, wakeCommentId: comment.id, reopenedFrom: "done", skipIssueComment: true,
          ...(mode === "fresh" ? { forceFreshSession: true } : {}) } });
      expect(second).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const after = await heartbeat.getRun(second!.id);
      expect(after?.status).toBe("succeeded");
      expect(inputs).toHaveLength(2);
      if (mode === "retained" || mode === "migrated") {
        const changedKeys = [...new Set(configs.flatMap(config => Object.keys(config)))].filter(key =>
          JSON.stringify(configs[0]?.[key]) !== JSON.stringify(configs.at(-1)?.[key]));
        expect(changedKeys).toEqual(mode === "migrated" ? ["lifecycleMode"] : []);
        expect(after).toMatchObject({ nativeSessionId: persisted.nativeSessionId, sessionIdAfter: providerSessionId });
        expect(openSession).toHaveBeenCalledOnce();
        expect(recoverSession).toHaveBeenCalledOnce();
      } else {
        expect(after?.nativeSessionId).not.toBe(persisted.nativeSessionId);
        expect(after?.sessionIdAfter).not.toBe(providerSessionId);
        expect(openSession).toHaveBeenCalledTimes(2);
        expect(recoverSession).not.toHaveBeenCalled();
      }
      expect(startTurn).toHaveBeenCalledTimes(2);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, second!.id))).toHaveLength(1);
      if (mode === "fresh") {
        expect(await heartbeat.listTaskSessions(agentId)).toEqual([expect.objectContaining({
          lastRunId: second!.id, sessionParamsJson: expect.objectContaining({ sessionId: after!.nativeSessionId }),
          sessionDisplayId: after!.sessionIdAfter,
        })]);
        await issuesSvc.update(issueId, { status: "todo", actorUserId: "pointer-user" });
        const followup = await issuesSvc.addComment(issueId, "Continue the fresh session's saved work.", { userId: "pointer-user" });
        const third = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_reopened_via_comment",
          requestedByActorType: "user", requestedByActorId: "pointer-user",
          payload: { issueId, commentId: followup.id, mutation: "comment", reopenedFrom: "done" },
          contextSnapshot: { issueId, taskId: issueId, wakeCommentId: followup.id, reopenedFrom: "done", skipIssueComment: true } });
        expect(third).not.toBeNull();
        await heartbeat.drainActiveRunExecutions();
        expect(await heartbeat.getRun(third!.id)).toMatchObject({ status: "succeeded",
          nativeSessionId: after!.nativeSessionId, sessionIdAfter: after!.sessionIdAfter });
        expect(inputs).toHaveLength(3);
        expect(openSession).toHaveBeenCalledTimes(2);
        expect(recoverSession).toHaveBeenCalledOnce();
        expect(startTurn).toHaveBeenCalledTimes(3);
        expect(await db.select().from(nativeRunResults).where(inArray(nativeRunResults.runId, [first!.id, second!.id, third!.id]))).toHaveLength(3);
      }
    } finally {
      releaseClose();
      try {
        await heartbeat.drainActiveRunExecutions();
      } finally {
        configuration.mockRestore();
        if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
        else process.env.PAPERCLIP_HOME = previousHome;
        home.cleanup();
      }
    }
  }, 30_000);
});

enableRunFailureReporting();
