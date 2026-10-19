import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentRuntimeState, agentWakeupRequests, activityLog, companies, createDb, heartbeatRuns,
  issueComments, issueInboxArchives, issueRecoveryActions, issueThreadInteractions, issues,
} from "@paperclipai/db";
import {
  createFileSystemSandboxCallbackBridgeQueueClient,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping recovery bridge tests: ${support.reason}`);

describePostgres("recovery resolution through the sandbox bridge", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-recovery-bridge-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const peerId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `RB${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Recovery bridge test", issuePrefix: prefix });
    await db.insert(agents).values([agentId, peerId].map(id => ({
      id, companyId, name: id, role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "manual", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Verify the saved result", status: "blocked",
      assigneeAgentId: agentId, issueNumber: 1, identifier: `${prefix}-1`,
      checkoutRunId: runId, executionRunId: runId,
    });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId: issueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: agentId, cause: "deliberate_wait_without_target", fingerprint: `repair:${issueId}`,
      evidence: { latestIssueStatus: "blocked" }, nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "board_escalation" },
    });
    return { companyId, agentId, peerId, issueId, runId, action };
  }

  async function throughBridge(
    fixture: Awaited<ReturnType<typeof seed>>,
    options: { agentId?: string; companyId?: string; runId?: string | null; outcome?: string; method?: "GET" | "POST" } = {},
  ) {
    const agentId = options.agentId ?? fixture.agentId;
    const runId = options.runId === null ? undefined : options.runId
      ?? (agentId === fixture.agentId ? fixture.runId : randomUUID());
    if (!options.companyId && runId && runId !== fixture.runId) {
      await db.insert(heartbeatRuns).values({
        id: runId, companyId: fixture.companyId, agentId, invocationSource: "manual", status: "running",
        startedAt: new Date(), contextSnapshot: { issueId: fixture.issueId },
      });
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent", agentId,
        companyId: options.companyId ?? fixture.companyId,
        runId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const queueDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-recovery-bridge-"));
    let forwarded = 0;
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(), queueDir,
      handleRequest: async message => {
        forwarded += 1;
        const pending = message.method === "GET" ? request(server).get(message.path) : request(server).post(message.path);
        const response = await pending.set(message.headers).send(message.body || undefined);
        return { status: response.status, body: JSON.stringify(response.body) };
      },
    });
    try {
      const directories = sandboxCallbackBridgeDirectories(queueDir);
      const method = options.method ?? "POST";
      await writeFile(path.join(directories.requestsDir, "recovery.json"), JSON.stringify({
        id: "recovery", method,
        path: `/api/issues/${fixture.issueId}/recovery-actions${method === "POST" ? "/resolve" : ""}`,
        query: "", headers: { "content-type": "application/json" }, createdAt: new Date().toISOString(),
        body: method === "GET" ? "" : JSON.stringify({
          actionId: fixture.action.id, outcome: options.outcome ?? "restored", sourceIssueStatus: "done",
          resolutionNote: "The saved result meets the task requirements. Verification limits are recorded.",
        }),
      }));
      await worker.stop({ drainTimeoutMs: 10_000 });
      const response = JSON.parse(await readFile(path.join(directories.responsesDir, "recovery.json"), "utf8"));
      expect(forwarded).toBe(1);
      return { status: response.status, body: JSON.parse(response.body) };
    } finally {
      await worker.stop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(queueDir, { recursive: true, force: true });
    }
  }

  async function expectUnchanged(fixture: Awaited<ReturnType<typeof seed>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.action.id));
    expect(issue).toMatchObject({ status: "blocked", assigneeAgentId: fixture.agentId });
    expect(action).toMatchObject({ status: "active", outcome: null, resolvedAt: null });
  }

  it("lets the assignee read and resolve a board-escalated recovery without a board card", async () => {
    const fixture = await seed();
    const read = await throughBridge(fixture, { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body.active.id).toBe(fixture.action.id);
    const resolved = await throughBridge(fixture);
    expect(resolved.status).toBe(200);
    expect(resolved.body.issue).toMatchObject({ id: fixture.issueId, status: "done", assigneeAgentId: fixture.agentId });
    expect(resolved.body.recoveryAction).toMatchObject({ id: fixture.action.id, status: "resolved", outcome: "owner_completed" });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.action.id));
    expect(action).toMatchObject({ status: "resolved", outcome: "owner_completed" });
    const log = await db.select().from(activityLog).where(eq(activityLog.entityId, fixture.issueId));
    expect(log).toEqual(expect.arrayContaining([expect.objectContaining({
      action: "issue.recovery_action_resolved", actorId: fixture.agentId, runId: fixture.runId,
    })]));
  });

  it("denies an unrelated agent in the same company", async () => {
    const fixture = await seed();
    const response = await throughBridge(fixture, { agentId: fixture.peerId });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Agent cannot resolve another owner's recovery action");
    await expectUnchanged(fixture);
  });

  it("denies another company", async () => {
    const fixture = await seed();
    expect((await throughBridge(fixture, { companyId: randomUUID(), agentId: randomUUID() })).status).toBe(404);
    await expectUnchanged(fixture);
  });

  it.each(["false_positive", "cancelled"])("keeps %s restricted to the board", async outcome => {
    const fixture = await seed();
    expect((await throughBridge(fixture, { outcome })).status).toBe(403);
    await expectUnchanged(fixture);
  });

  it("requires a run identifier", async () => {
    const fixture = await seed();
    expect((await throughBridge(fixture, { runId: null })).status).toBe(401);
    await expectUnchanged(fixture);
  });

  it("denies a run that belongs to another agent", async () => {
    const fixture = await seed();
    const response = await throughBridge(fixture, { agentId: fixture.peerId, runId: fixture.runId });
    expect(response.status).toBe(403);
    expect(response.body.details.code).toBe("cross_issue_influence_run_context_required");
    await expectUnchanged(fixture);
  });
});
