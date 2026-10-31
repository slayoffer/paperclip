import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentTaskSessions, agentWakeupRequests, authUsers, companies,
  companyMemberships, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
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

  it.each(["absent", "stale"])("restores the capped run through real wake admission with a task checkpoint that is %s", async (checkpoint) => {
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
    // This is the durable state after terminal success, before upsertTaskSession.
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
    await recovery.reconcileLegacyContinuation(source.id);

    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "run_token_cap"),
    ));
    expect(wakes).toHaveLength(1);
    const successor = await heartbeat.getRun(wakes[0].runId!);
    expect(successor).toMatchObject({ status: "queued", sessionIdBefore: sourceSessionId,
      contextSnapshot: { runTokenCapSourceRunId: source.id, resumeFromRunId: source.id,
        resumeSessionDisplayId: sourceSessionId, resumeSessionParams: { sessionId: sourceSessionId } },
    });
    expect(wakes[0].payload).toMatchObject({ issueId, resumeFromRunId: source.id });
    const taskSessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agent.id));
    if (checkpoint === "absent") expect(taskSessions).toHaveLength(0);
    else expect(taskSessions[0]).toMatchObject({ sessionDisplayId: oldSessionId, lastRunId: active.id });
  });
});
