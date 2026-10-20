import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, documents, heartbeatRuns, issueDocuments, issueRelations, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readAgentAuthenticationRun } from "../middleware/auth-run-projection.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { listNewerAgentRunActivity } from "../services/agent-run-activity.js";
import { withCompanyAgentReadBatch } from "../services/agent-read-batch.js";
import { agentService } from "../services/agents.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("issue read projections with large run payloads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const since = new Date("2026-10-01T00:00:00Z");
  const createdAt = new Date("2026-10-20T00:00:00Z");
  const queries: string[] = [];
  const claims = { sub: agentId, company_id: companyId, run_id: runId };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-issue-read-perf-");
    db = createDb(database.connectionString);
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    await db.insert(companies).values([{ id: companyId, name: "Read fixture", issuePrefix: "PRF" },
      { id: otherCompanyId, name: "Foreign fixture", issuePrefix: "EXT" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture reader", role: "engineer", adapterType: "codex_local" });
    const peers = Array.from({ length: 18 }, () => randomUUID());
    await db.insert(agents).values(peers.map((id, index) => ({ id, companyId, name: `Peer ${index}`, role: "engineer" })));
    let parentId: string | null = null;
    for (let index = 0; index < 6; index += 1) {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId, parentId, title: `Ancestor ${index}`, description: "Ancestor context" });
      parentId = id;
    }
    await db.insert(issues).values({ id: issueId, companyId, parentId, assigneeAgentId: agentId,
      identifier: "PRF-1", title: "Read fixture", description: "x".repeat(50000), status: "blocked" });
    for (let index = 0; index < 8; index += 1) {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: `Blocker ${index}`, assigneeAgentId: peers[index], status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    }
    for (let index = 0; index < 10; index += 1) {
      const documentId = randomUUID();
      await db.insert(documents).values({ id: documentId, companyId, title: `Document ${index}`, latestBody: "Document content".repeat(500) });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: `fixture-${index}` });
    }
    // Random data prevents PostgreSQL compression from hiding the TOAST cost.
    for (let batch = 0; batch < 8; batch += 1) {
      await db.insert(heartbeatRuns).values(Array.from({ length: 16 }, (_, index) => ({
        id: batch === 0 && index === 0 ? runId : randomUUID(), companyId, agentId,
        status: "running", createdAt,
        contextSnapshot: { issueId, conversationMode: true, padding: randomBytes(30000).toString("base64") },
        resultJson: { padding: randomBytes(107250).toString("base64") },
      })));
    }
  }, 90000);
  afterAll(async () => { await database?.cleanup(); });

  it("backfills stored values when the migration sees historical rows", async () => {
    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0306_futuristic_lethal_legion.sql", import.meta.url), "utf8");
    await db.transaction(async (tx) => {
      await tx.execute(sql`create temporary table heartbeat_runs (company_id uuid, agent_id uuid,
        created_at timestamptz, context_snapshot jsonb, result_json jsonb, status text) on commit drop`);
      await tx.execute(sql`insert into heartbeat_runs values (${companyId}, ${agentId}, now(),
        ${JSON.stringify({ issueId, conversationMode: true })}::jsonb,
        '{"executionCancellation":{"state":"requested"}}'::jsonb, 'running')`);
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      const rows = await tx.execute(sql`select context_task_identity, context_issue_id, writes_revoked, conversation_mode from heartbeat_runs`);
      expect(rows[0]).toEqual({ context_task_identity: issueId, context_issue_id: issueId, writes_revoked: true, conversation_mode: true });
    });
  });

  it("stores scalar values and updates them with payloads", async () => {
    const [row] = await db.select({ identity: heartbeatRuns.contextTaskIdentity, issue: heartbeatRuns.contextIssueId,
      task: heartbeatRuns.contextTaskId, revoked: heartbeatRuns.writesRevoked, conversation: heartbeatRuns.conversationMode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(row).toEqual({ identity: issueId, issue: issueId, task: null, revoked: false, conversation: true });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: null, taskId: issueId },
      resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, runId));
    expect(agentRunWritesRevoked(await readAgentAuthenticationRun(db, claims))).toBe(true);
    const [updated] = await db.select({ identity: heartbeatRuns.contextTaskIdentity }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updated.identity).toBe(issueId);
    await db.update(heartbeatRuns).set({
      contextSnapshot: { issueId, conversationMode: true, padding: randomBytes(30000).toString("base64") },
      resultJson: { padding: randomBytes(107250).toString("base64") },
    }).where(eq(heartbeatRuns.id, runId));
  });

  it("preserves cancellation checks and company and agent boundaries", async () => {
    const run = await readAgentAuthenticationRun(db, claims);
    expect(run?.conversationMode).toBe(true);
    expect(run).not.toHaveProperty("resultJson");
    expect(run).not.toHaveProperty("contextSnapshot");
    expect(agentRunWritesRevoked(run)).toBe(false);
    expect(await readAgentAuthenticationRun(db, { ...claims, company_id: otherCompanyId })).toBeUndefined();
    expect(await readAgentAuthenticationRun(db, { ...claims, sub: randomUUID() })).toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    expect(agentRunWritesRevoked(await readAgentAuthenticationRun(db, claims))).toBe(true);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
  });

  it("preserves exact stop identifiers for cancelled mutations", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { issueMutationStopId: 42 } }).where(eq(heartbeatRuns.id, runId));
    await expect(db.transaction((tx) => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId,
      { agentId, runId, stopId: "42" }))).rejects.toThrow("This run was cancelled");
    await db.update(heartbeatRuns).set({ resultJson: { issueMutationStopId: "allowed" } }).where(eq(heartbeatRuns.id, runId));
    await expect(db.transaction((tx) => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId,
      { agentId, runId, stopId: "allowed" }))).resolves.toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "running", resultJson: { padding: randomBytes(107250).toString("base64") } }).where(eq(heartbeatRuns.id, runId));
  });

  it("reads activity through the covering index without a context expression", async () => {
    expect(await listNewerAgentRunActivity(db, companyId, [agentId], since)).toHaveLength(128);
    expect(await listNewerAgentRunActivity(db, otherCompanyId, [agentId], since)).toEqual([]);
    await db.execute(sql`vacuum analyze heartbeat_runs`);
    await db.execute(sql`set enable_seqscan = off`);
    const plan = await db.execute(sql`explain (format json) select agent_id, created_at, context_issue_id, context_task_id
      from heartbeat_runs where company_id = ${companyId} and agent_id = ${agentId} and created_at > ${since.toISOString()}`);
    expect(JSON.stringify(plan)).toContain("heartbeat_runs_company_agent_activity_idx");
    expect(JSON.stringify(plan)).toContain("Index Only Scan");
    await db.execute(sql`reset enable_seqscan`);
  });

  it("uses one agent batch and one monthly cost query", async () => {
    await db.insert(costEvents).values({ companyId, agentId, provider: "fixture", model: "fixture", costCents: 5,
      occurredAt: new Date(), inputTokens: 1, outputTokens: 1 });
    const service = agentService(db);
    queries.length = 0;
    const agent = await withCompanyAgentReadBatch(db, companyId, async () => {
      const [first, second] = await Promise.all([service.getById(agentId), service.getById(agentId)]);
      expect(first).toBe(second);
      expect(await service.getById(randomUUID())).toBeNull();
      return first;
    });
    expect(agent?.spentMonthlyCents).toBe(5);
    expect(queries.filter((query) => query.includes('from "agents"'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('from "cost_events"'))).toHaveLength(1);
    expect(await withCompanyAgentReadBatch(db, otherCompanyId, () => service.getById(agentId))).toBeNull();
  });

  it("captures authentication identity without result or context data", async () => {
    const { run } = await captureRunIdentity(db, { companyId, agentId, runId, includeContext: false });
    expect(run.contextSnapshot).toBeNull();
    expect(run).not.toHaveProperty("resultJson");
    expect(run.id).toBe(runId);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: 42, taskId: issueId } }).where(eq(heartbeatRuns.id, runId));
    await expect(captureRunIdentity(db, { companyId, agentId, runId, includeContext: false })).rejects.toThrow("Run task identity is invalid");
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, conversationMode: true,
      padding: randomBytes(30000).toString("base64") } }).where(eq(heartbeatRuns.id, runId));
  });

  it("reports HTTP latency with eight concurrent run readers", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    let active = true;
    let backgroundReads = 0;
    const readers = Array.from({ length: 8 }, async () => {
      while (active) {
        await readAgentAuthenticationRun(db, claims);
        await captureRunIdentity(db, { companyId, agentId, runId, includeContext: false });
        backgroundReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    const samples: Record<string, number[]> = { light: [], full: [] };
    try {
      for (let index = 0; index < 45; index += 1) {
        for (const view of ["light", "full"]) {
          const start = performance.now();
          const response = await request(server).get(`/api/issues/PRF-1${view === "light" ? "?view=light" : ""}`);
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(response.body.id).toBe(issueId);
          if (index >= 5) samples[view].push(performance.now() - start);
        }
      }
    } finally {
      active = false;
      await Promise.all(readers);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const measurements = Object.fromEntries(Object.entries(samples).map(([view, values]) => {
      values.sort((a, b) => a - b);
      return [view, { requests: values.length, p50: values[Math.floor(values.length / 2)],
        p95: values[Math.ceil(values.length * 0.95) - 1], max: values.at(-1) }];
    }));
    const evidence = { measurements, backgroundReads, runs: 128, readers: 8, agents: 19,
      ancestors: 6, blockers: 8, documents: 10, resultBytes: 143000, contextBytes: 40000 };
    console.log("ISSUE_READ_BENCHMARK", JSON.stringify(evidence));
    if (process.env.PAPERCLIP_ISSUE_READ_BENCHMARK_OUTPUT) {
      writeFileSync(process.env.PAPERCLIP_ISSUE_READ_BENCHMARK_OUTPUT, JSON.stringify(evidence, null, 2));
    }
    expect(backgroundReads).toBeGreaterThan(0);
  }, 90000);
});
