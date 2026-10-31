import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentTaskSessions, agentWakeupRequests, authUsers, companies,
  companyMemberships, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { sessionCodec } from "@paperclipai/adapter-codex-local/server";
import { adapterExecutionTargetSessionMatches } from "@paperclipai/adapter-utils/execution-target";
import { refreshIssueContinuationSummary } from "../services/issue-continuation-summary.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("cap recovery before task-session persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-cap-restart-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it.each(["absent", "stale"])("waits for a complete source checkpoint when the task checkpoint is %s", async (checkpoint) => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const responsibleUserId = randomUUID();
    const oldSessionId = randomUUID();
    const sourceSessionId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Owner",
      email: `${responsibleUserId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Restart checkpoint",
      issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: responsibleUserId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user",
      principalId: responsibleUserId, status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Codex owner", role: "engineer",
      status: "running", adapterType: "codex_local", adapterConfig: { engine: "cli" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the capped session",
      status: "in_progress", assigneeAgentId: agent.id, responsibleUserId });
    // Occupy the execution slot so the real admission path queues without starting a provider.
    const [active] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "running", invocationSource: "on_demand", sessionIdAfter: oldSessionId }).returning();
    if (checkpoint === "stale") {
      await db.insert(agentTaskSessions).values({ companyId, agentId: agent.id, adapterType: agent.adapterType,
        taskKey: issueId, sessionParamsJson: { sessionId: oldSessionId },
        sessionDisplayId: oldSessionId, lastRunId: active.id });
    }
    // Reproduce the old terminal-success gap. Recovery must hold until the source checkpoint is present.
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id,
      status: "succeeded", invocationSource: "assignment", finishedAt: new Date(),
      contextSnapshot: { issueId, taskKey: issueId }, sessionIdBefore: oldSessionId,
      sessionIdAfter: sourceSessionId,
      resultJson: { stopReason: "run_token_cap", summary: "Completed A. Continue B from this session." },
    }).returning();
    await refreshIssueContinuationSummary({ db, issueId, run: source, agent });

    const heartbeat = heartbeatService(db);
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
    await recovery.reconcileLegacyContinuation(source.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    const remoteExecution = { transport: "ssh", host: "fixture.invalid", port: 22,
      username: "fixture", remoteCwd: "/workspace" };
    const params = { sessionId: sourceSessionId, cwd: "/workspace", remoteExecution };
    await db.insert(agentTaskSessions).values({ companyId, agentId: agent.id, adapterType: agent.adapterType,
      taskKey: issueId, sessionParamsJson: sessionCodec.serialize(params),
      sessionDisplayId: sourceSessionId, lastRunId: source.id,
    }).onConflictDoUpdate({ target: [agentTaskSessions.companyId, agentTaskSessions.agentId,
      agentTaskSessions.adapterType, agentTaskSessions.taskKey], set: {
      sessionParamsJson: sessionCodec.serialize(params), sessionDisplayId: sourceSessionId, lastRunId: source.id,
    } });
    await recovery.reconcileLegacyContinuation(source.id);
    await recovery.reconcileLegacyContinuation(source.id);

    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "run_token_cap"),
    ));
    expect(wakes).toHaveLength(1);
    const successor = await heartbeat.getRun(wakes[0].runId!);
    expect(successor).toMatchObject({ status: "queued", sessionIdBefore: sourceSessionId,
      contextSnapshot: { runTokenCapSourceRunId: source.id },
    });
    expect(wakes[0].payload?.resumeFromRunId).toBeUndefined();
    expect(successor?.contextSnapshot?.resumeSessionParams).toBeUndefined();
    const taskSessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
    expect(taskSessions[0]).toMatchObject({ sessionDisplayId: sourceSessionId, lastRunId: source.id });
    const restored = sessionCodec.deserialize(taskSessions[0].sessionParamsJson);
    expect(restored).toEqual(params);
    expect(adapterExecutionTargetSessionMatches(restored?.remoteExecution, {
      kind: "remote", transport: "ssh", remoteCwd: remoteExecution.remoteCwd, spec: {
        host: remoteExecution.host, port: remoteExecution.port, username: remoteExecution.username,
        remoteWorkspacePath: remoteExecution.remoteCwd, remoteCwd: remoteExecution.remoteCwd,
        privateKey: null, knownHosts: null, strictHostKeyChecking: true,
      },
    })).toBe(true);
  });
});
