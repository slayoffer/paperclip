import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, executionWorkspaces, heartbeatRuns, issueComments, issueWorkProducts, issues, nativeRunFinalizations, projectWorkspaces, projects } from "@paperclipai/db";
import { type NativeExecutionInputV1, type NativeSession, type NativeSessionBackend, type PersistedNativeSession, type PrpEvent } from "@paperclipai/paperclip-runner";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";

export type RecoveryVariant = "unchanged" | "newer_active" | "stale_idle";
export function createPersistedRecoveryFixture(variant: RecoveryVariant) {
  const newerRequest = variant !== "unchanged";
  const staleIdleCheckpoint = variant === "stale_idle";
  let temporary: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;
  const state = { staleProviderProcess: null as ReturnType<typeof spawn> | null };
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const executionWorkspaceId = randomUUID();
  const newerExecutionWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const freshIssueId = randomUUID();
  const runId = randomUUID();
  const contractId = randomUUID();
  const workProductId = randomUUID();
  const sessionId = randomUUID();
  const runnerInstanceId = randomUUID();
  const newerCommentId = randomUUID();
  const newerWakeKey = `newer-comment:${newerCommentId}`;
  const turnId = "provider-active-turn";
  const providerSessionId = "provider-existing-session";
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const contract = {
    revision: "phase6-recovery-v1",
    objective: "Recover the persisted provider turn",
    criteria: [
      { id: "objective", requirement: "Complete through same-run recovery" },
    ],
  };
  const contractSha = "phase6-recovery-contract";
  const evidenceRef = `work_product:${workProductId}`;
  const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
  result.completionClaim.contractRevision = contract.revision;
  result.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
  result.evidence = [{ kind: "work_product", ref: evidenceRef }];
  result.verification[0]!.artifactRef = evidenceRef;
  result.summary = "Recovered the already-active provider turn.";
  const terminal = {
    ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
    reportedWorkDisposition: result.reportedWorkDisposition,
  };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { companyId, runId, issueId, agentId, executionWorkspaceId },
    task: {
      identifier: "NRR-1",
      title: "Recover one native heartbeat",
      description: null,
      workMode: "standard",
    },
    workspace: {
      cwd: repoRoot,
      repoUrl: null,
      repoRef: null,
      branchName: null,
    },
    session: {
      normalizedSessionId: sessionId,
      driverKind: "codex_app_server",
      protocolVersion: 1,
    },
    provider: { kind: "codex", model: null },
    completionContract: {
      id: contractId,
      sha256: contractSha,
      schemaVersion: "paperclip.completion-contract.v1",
      contract,
    },
    interactionResponses: [],
    credentialBindings: [],
  };
  const checkpoint: PersistedNativeSession = {
    backendKind: "mock",
    sessionId: "driver-existing-session",
    identity: { companyId, runId, issueId, agentId, sessionId },
    providerSessionId,
    cursor: "1",
    activeTurnId: staleIdleCheckpoint ? null : turnId,
    pendingRuntimeRequests: [],
    lineage: [],
  };
  const providerTerminalEvent: PrpEvent = {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${runnerInstanceId}:provider-terminal`,
    sourceSeq: 1,
    sourceInstanceId: runnerInstanceId,
    sourceKind: "runner",
    runId,
    normalizedSessionId: sessionId,
    turnId,
    eventType: "turn.completed",
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T04:30:00.000Z",
    payload: {},
  };
  const openSession = vi.fn(async () => {
    throw new Error(
      "same-run recovery must not open a second provider session",
    );
  });
  const startTurn = vi.fn<NativeSession["startTurn"]>(async () => {
    throw new Error(
      "recovering old work must not start a replacement provider turn",
    );
  });
  const close = vi.fn(async () => undefined);
  const recoverSession = vi.fn(async (persisted: PersistedNativeSession) => {
    expect(persisted).toMatchObject({
      providerSessionId,
      activeTurnId: staleIdleCheckpoint ? null : turnId,
    });
    expect(state.staleProviderProcess).not.toBeNull();
    expect(
      state.staleProviderProcess!.exitCode !== null ||
        state.staleProviderProcess!.signalCode !== null,
    ).toBe(true);
    // Model the real launch/checkpoint gap: the durable DB snapshot may still
    // look idle, while the recovered provider has already started the old turn.
    const recoveredSnapshot: PersistedNativeSession = {
      ...structuredClone(checkpoint),
      cursor: "2",
      activeTurnId: turnId,
    };
    const session: NativeSession = {
      identity: () => structuredClone(checkpoint.identity),
      async capabilities() {
        return {
          resume: true,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
        };
      },
      async *events() {
        yield providerTerminalEvent;
      },
      startTurn,
      async result() {
        return { result, terminal, turnId };
      },
      async snapshot() {
        return structuredClone(recoveredSnapshot);
      },
      close,
    };
    return { recovered: true, session };
  });
  const backend: NativeSessionBackend = {
    async descriptor() {
      return {
        kind: "mock",
        name: "persisted-recovery-backend",
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
    openSession,
    recoverSession,
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "paperclip-native-reaper-e2e-",
    );
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({
      enableNativeRunner: newerRequest,
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Native same-run recovery",
      issuePrefix: "NRR",
      status: "active",
      defaultResponsibleUserId: "responsible-user",
    });
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(
      companyId,
    );
    await db
      .insert(projects)
      .values({
        id: projectId,
        companyId,
        name: "Recovery project",
        status: "active",
      });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Recovery workspace",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native recovery agent",
      adapterType: "paperclip_runner",
      // Match the persisted fixture workspace's strategy explicitly. A
      // metadata-free workspace is not proof of the current config; an actual
      // strategy change correctly refuses immutable native-input rebinding.
      adapterConfig: { workspaceStrategy: { type: "project_primary" } },
      status: "active",
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        nativeRunner: {
          mode: "native",
          backend: "codex_app_server",
          protocolVersion: 1,
        },
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      issueNumber: 1,
      identifier: "NRR-1",
      title: "Recover one native heartbeat",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Persisted recovery workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
      // Recovery must use the environment admitted for the persisted turn.
      metadata: { config: { environmentId: localEnvironment.id } },
    });
    await db.insert(executionWorkspaces).values({
      id: newerExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Newer issue workspace",
      status: "active",
      cwd: repoRoot,
      providerType: "local_fs",
      // Recovery must use the environment admitted for the persisted turn.
      metadata: { config: { environmentId: localEnvironment.id } },
    });
    await db
      .update(issues)
      .set({
        // Simulate a newer run moving the issue-level pointer before the older native run is
        // recovered. The older run must still restore its own immutable workspace binding.
        executionWorkspaceId: newerExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "shared_workspace" },
      })
      .where(eq(issues.id, issueId));
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: contract,
      canonicalSha256: contractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Recovered result evidence",
      status: "ready_for_review",
      reviewState: "approved",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolverVersion: "phase6-v1",
      runtimeModeReason: "eligible_opt_in",
      runtimeModeResolvedAt: new Date("2026-08-09T04:00:00.000Z"),
      runnerProfileJson: {
        mode: "native",
        backend: "codex_app_server",
        protocolVersion: 1,
        nativeExecutionInput: execution,
        sessionCheckpoint: checkpoint,
      },
      runnerInstanceId,
      nativeSessionId: sessionId,
      driverKind: "codex_app_server",
      driverVersion: "phase6-v1",
      completionContractId: contractId,
      completionContractSha256: contractSha,
      nativePhase: "retryable_failure",
      nativePhaseUpdatedAt: new Date("2026-08-09T04:00:00.000Z"),
      startedAt: new Date("2026-08-09T04:00:00.000Z"),
      contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date(0),
    });
    if (newerRequest)
      await db.insert(issueComments).values({
        id: newerCommentId,
        companyId,
        issueId,
        authorUserId: "responsible-user",
        body: "Verify the newest user instruction before completing this task.",
      });
  }, 30_000);

  afterAll(async () => {
    if (
      state.staleProviderProcess &&
      state.staleProviderProcess.exitCode === null &&
      state.staleProviderProcess.signalCode === null
    ) {
      state.staleProviderProcess.kill("SIGKILL");
    }
    if (temporary) {
      await drainHeartbeatRunsToQuiescence(
        db,
        heartbeatService(db, {
          runtimeEnv: { PAPERCLIP_INSTANCE_ID: "phase6-recovery-test" },
          nativeSessionBackendFactory: () => backend,
        }),
      );
      await temporary.cleanup();
    }
  });

  return {
    get db() { return db; },
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
  };
}
