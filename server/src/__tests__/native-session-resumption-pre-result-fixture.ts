import { afterAll, beforeAll } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

export function createPreResultFixture() {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "79000000-0000-4000-8000-000000000001";
  const agentId = "79000000-0000-4000-8000-000000000002";
  const issueId = "79000000-0000-4000-8000-000000000003";
  const runId = "79000000-0000-4000-8000-000000000004";
  const cancelledRunId = "79000000-0000-4000-8000-000000000005";
  const exhaustedRunId = "79000000-0000-4000-8000-000000000006";
  const missingCheckpointRunId = "79000000-0000-4000-8000-000000000007";
  const initialRunId = "79000000-0000-4000-8000-000000000008";
  const bootstrapRetryRunId = "79000000-0000-4000-8000-000000000009";
  const observedExpiredRunId = "79000000-0000-4000-8000-000000000010";
  const observedLivePidRunId = "79000000-0000-4000-8000-000000000011";
  const persistedProfile = {
    mode: "native",
    nativeExecutionInput: { schema: "paperclip.native-execution-input.v1", binding: { runId } },
    sessionCheckpoint: {
      backendKind: "codex_app_server",
      sessionId: "persisted-session",
      identity: { runId },
      providerSessionId: "provider-session",
      activeTurnId: "active-turn",
    },
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-resume-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native resume", issuePrefix: "NRR" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native resume agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume the same native run",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: cancelledRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "cancelled",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: exhaustedRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: missingCheckpointRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: missingCheckpointRunId },
          },
        },
        contextSnapshot: { issueId },
      },
      {
        id: initialRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: initialRunId },
          },
        },
        contextSnapshot: { issueId },
      },
      {
        id: bootstrapRetryRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: bootstrapRetryRunId },
          },
        },
        errorCode: "provider_initialize_timeout",
        contextSnapshot: { issueId },
      },
      ...[observedExpiredRunId, observedLivePidRunId].map((observedRunId) => ({
        id: observedRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        status: "running" as const,
        runtimeMode: "native" as const,
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: {
          ...persistedProfile,
          nativeExecutionInput: {
            ...persistedProfile.nativeExecutionInput,
            binding: { runId: observedRunId },
          },
          sessionCheckpoint: {
            ...persistedProfile.sessionCheckpoint,
            identity: { runId: observedRunId },
          },
        },
        contextSnapshot: { issueId },
      })),
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: cancelledRunId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: exhaustedRunId, companyId, issueId, phase: "terminal_failure", attempt: 3 },
      { runId: missingCheckpointRunId, companyId, issueId, phase: "retryable_failure", attempt: 1 },
      { runId: initialRunId, companyId, issueId, phase: "observed", attempt: 0 },
      {
        runId: bootstrapRetryRunId,
        companyId,
        issueId,
        phase: "retryable_failure",
        attempt: 1,
        nextAttemptAt: new Date(0),
        failureCode: "native_session_interrupted",
        failureDetail: {
          message: "provider_initialize_timeout: provider=opencode stage=health",
          originalFailureCode: "provider_initialize_timeout",
          recoveryMode: "bootstrap_retry",
          providerSessionEstablished: false,
          providerEventsExist: false,
          checkpointExists: false,
        },
      },
      ...[observedExpiredRunId, observedLivePidRunId].map((observedRunId) => ({
        runId: observedRunId,
        companyId,
        issueId,
        phase: "observed" as const,
        attempt: 2,
        leaseOwner: "prior-native-owner",
        leaseExpiresAt: new Date(0),
      })),
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  return {
    get db() { return db; },
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
  };
}
