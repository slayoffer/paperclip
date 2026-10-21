import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as chatCompletion from "../services/chat-completion-delivery.js";
import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.js";
import { readProcessStartedAt } from "../services/hot-restart.js";
import { NativeRunnerOwnershipUnverifiedError } from "../services/native-runtime/native-runner-ownership.js";
import { taskDrainService } from "../services/task-drain.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping drain recovery tests: ${support.reason}`);

describeDatabase("task drain during native restart recovery", () => {
  it.each([
    { runnerKind: "local", hold: "persisted", dispatched: true, setupFailure: false },
    { runnerKind: "remote", hold: "persisted", dispatched: true, setupFailure: false },
    { runnerKind: "local", hold: "local", dispatched: true, setupFailure: false },
    { runnerKind: "remote", hold: "local", dispatched: true, setupFailure: false },
    { runnerKind: "local", hold: "restore", dispatched: false, setupFailure: false },
    { runnerKind: "remote", hold: "worktree", dispatched: false, setupFailure: false },
    { runnerKind: "bootstrap", hold: "persisted", dispatched: false, setupFailure: false },
    { runnerKind: "dead", hold: "persisted", dispatched: false, setupFailure: false },
    { runnerKind: "local", hold: "persisted", dispatched: true, setupFailure: true },
    { runnerKind: "remote", hold: "persisted", dispatched: true, setupFailure: true },
  ] as const)("preserves $runnerKind ownership under a $hold hold (setup failure: $setupFailure)", async ({ runnerKind, hold, dispatched, setupFailure }) => {
    const database = await startEmbeddedPostgresTestDatabase("task-drain-recovery-");
    const db = createDb(database.connectionString);
    const originalHome = process.env.PAPERCLIP_HOME;
    const home = await mkdtemp(join(tmpdir(), "task-drain-recovery-home-"));
    process.env.PAPERCLIP_HOME = home;
    const runner = runnerKind === "local"
      ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: "ignore" })
      : null;
    // Stop before workspace, credential, and provider preparation. The real
    // restart classifier and executeRun admission path remain active.
    const dispatch = vi.spyOn(chatCompletion, "prepareChatCompletionTurn");
    if (!setupFailure) dispatch.mockImplementation(async () => {
      throw new NativeRunnerOwnershipUnverifiedError();
    });
    let heartbeat: ReturnType<typeof heartbeatService> | undefined;
    try {
      if (runner) await once(runner, "spawn");
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      const sessionId = randomUUID();
      const startedAt = runner ? await readProcessStartedAt(runner.pid!) : null;
      if (runner) expect(startedAt).toBeTruthy();
      const lockedAt = new Date();
      const profile = runnerKind === "bootstrap" ? {} : {
        sessionCheckpoint: {
          identity: { companyId, issueId, runId, agentId, sessionId },
          providerSessionId: "existing-session",
        },
        ...(runnerKind === "remote" ? {
          nativeWorkspaceSync: {
            schema: "paperclip.native-workspace-sync/v1",
            state: "prepared",
            descriptorSha256: "a".repeat(64),
            baselineSha256: "b".repeat(64),
            workspaceId: randomUUID(),
            leaseId: randomUUID(),
            providerLeaseId: "existing-provider-lease",
            remoteCwd: "/workspace/task",
          },
        } : {}),
      };
      await db.insert(companies).values({ id: companyId, name: "Drain recovery", issuePrefix: "DRAIN" });
      await db.insert(agents).values({
        id: agentId, companyId, name: "Recovery", role: "engineer",
        adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
      });
      await db.insert(issues).values({
        id: issueId, companyId, title: "Existing work", status: "in_progress", assigneeAgentId: agentId,
        executionAgentNameKey: "recovery", executionLockedAt: lockedAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, nativeSessionId: sessionId, invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId }, startedAt: lockedAt,
        processPid: runner?.pid ?? null, processGroupId: runner?.pid ?? null,
        processStartedAt: startedAt ? new Date(startedAt) : null, runnerProfileJson: profile,
      });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      const drain = taskDrainService(db);
      if (hold === "local") startTaskDrain({});
      else await drain.acquire("operator-a", {}, async () => {});
      const runtimeEnv = hold === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
        : hold === "worktree" ? { PAPERCLIP_IN_WORKTREE: "true" } : {};
      heartbeat = heartbeatService(db, { runtimeEnv });
      const recovery = await heartbeat.recoverNativeRunsAfterRestart();
      const kind = runnerKind === "remote" ? "reattach_remote_runner"
        : runnerKind === "local" ? "reattach_existing_runner"
          : runnerKind === "bootstrap" ? "bootstrap_incomplete" : "resume_dead_runner";
      expect(recovery.claims).toEqual([expect.objectContaining({ kind, runId })]);
      await heartbeat.drainActiveRunExecutions();
      expect(dispatch).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(run).toMatchObject({ status: "running", startedAt: lockedAt, processPid: runner?.pid ?? null });
      expect(issue).toMatchObject({ executionRunId: runId, executionAgentNameKey: "recovery", executionLockedAt: lockedAt });
      if (runner) expect(runner.exitCode).toBeNull();
      if (hold !== "local") {
        expect(await heartbeat.getTaskDrainStatus()).toMatchObject({ draining: true, persistedRunningRuns: 1, quiescent: false });
      }
    } finally {
      await heartbeat?.drainActiveRunExecutions();
      dispatch.mockRestore();
      stopTaskDrain();
      if (runner && runner.exitCode === null) {
        const exited = once(runner, "exit");
        runner.kill("SIGTERM");
        await exited;
      }
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      await database.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
