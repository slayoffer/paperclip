import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues, issueThreadInteractions,
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { issueService } from "../services/issues.js";
import { assertBlockedIssueUpdate } from "../services/issue-blocked-validation.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { hasNonDependencyBlockedWait } from "../services/blocked-state-integrity.js";
import { classifyIssueGraphLiveness } from "../services/recovery/issue-graph-liveness.js";

const routeHeartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: routeHeartbeat.wakeup,
    }),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const head = "a".repeat(40);
const manifest = (identifier: string) => `\`\`\`handoff\nrepo: slayoffer/paperclip\nbase: ${"b".repeat(40)}\nhead: ${head}\nbranch: review/${identifier}\n\`\`\``;

describeDatabase("blocked-state integrity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let agentId: string;
  let source: typeof issues.$inferSelect;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-integrity-");
    db = createDb(database.connectionString);
    svc = issueService(db);
  }, 30_000);
  beforeEach(async () => {
    routeHeartbeat.wakeup.mockReset().mockResolvedValue(null);
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
    vi.stubEnv("PAPERCLIP_SELF_BLOCK_GUARD", "true");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Integrity", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    source = await issue("SYNA-1937", "in_progress", { assigneeAgentId: agentId });
  });
  afterEach(async () => {
    for (const table of [issueThreadInteractions, activityLog, issueComments, issueRelations, heartbeatRuns, agentWakeupRequests, issues, agents, companies]) await db.delete(table);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { vi.unstubAllEnvs(); await database?.cleanup(); });

  async function issue(identifier: string, status = "todo", extra: Partial<typeof issues.$inferInsert> = {}) {
    return (await db.insert(issues).values({ companyId, identifier, title: identifier, status, ...extra }).returning())[0]!;
  }
  async function link(blockerId: string, dependentId = source.id) {
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
  }
  const descriptor = (action = "Continue the work"): IssueUnblockDescriptor => ({ owner: { agentId }, action });
  function validate(unblockDescriptor?: IssueUnblockDescriptor | null, blockedByIssueIds?: string[]) {
    return assertBlockedIssueUpdate({
      db, actor: { type: "agent", companyId, agentId, source: "agent_jwt" }, existing: source,
      updateFields: { status: "blocked", unblockDescriptor }, requestedBlockerIds: blockedByIssueIds,
      getDependencyReadiness: svc.getDependencyReadiness,
    });
  }

  it("refuses a wait that names only the owner", async () => {
    await expect(validate(descriptor())).rejects.toMatchObject({ status: 409, details: { code: "self_block_refused" } });
  });
  it("accepts the owner's recorded handoff and treats it as a durable wait", async () => {
    const unblockDescriptor = descriptor(`Wait for the cross-vendor review of ${head}`);
    await db.insert(issueComments).values({ companyId, issueId: source.id, authorAgentId: agentId, body: manifest(source.identifier!) });
    await expect(validate(unblockDescriptor)).resolves.toBeUndefined();
    await svc.update(source.id, { status: "blocked", unblockDescriptor });
    const state = await collectDispositionRepairSourceState(db, { issue: (await svc.getById(source.id))! });
    expect(state).toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "recorded_wait" });
  });
  it("commits a handoff and the blocked state in one route request without a card", async () => {
    const wakeup = routeHeartbeat.wakeup;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      contextSnapshot: { issueId: source.id } }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id, executionRunId: run!.id }).where(eq(issues.id, source.id));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", companyId, agentId, runId: run!.id, source: "agent_jwt" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const res = await request(app).patch(`/api/issues/${source.id}`).send({
      status: "blocked", comment: manifest(source.identifier!),
      unblockDescriptor: descriptor(`Wait for the cross-vendor review of ${head}`),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    expect(await db.select().from(issueThreadInteractions)).toEqual([]);
    expect((await db.select().from(issueComments)).some(row => row.body === manifest(source.identifier!))).toBe(true);
    expect(wakeup.mock.calls).toEqual([]);
  });
  it("does not accept a stale handoff after a rejected review", async () => {
    await db.insert(issueComments).values({ companyId, issueId: source.id, authorAgentId: agentId,
      createdAt: new Date(Date.now() - 1000), body: manifest(source.identifier!) });
    await db.insert(issueComments).values({ companyId, issueId: source.id, authorUserId: "board",
      body: "Cross-vendor review r1 REJECTED\nCorrect the finding." });
    await expect(validate(descriptor(`Wait for review of ${head}`))).rejects.toMatchObject({ status: 409 });
  });
  it("accepts an actual issue dependency without a card", async () => {
    const blocker = await issue("SYNA-1707", "todo", { assigneeAgentId: agentId });
    await expect(validate(descriptor("Wait for SYNA-1707"), [blocker.id])).resolves.toBeUndefined();
  });
  it("preserves a stored board descriptor without changing its owner", async () => {
    const blocker = await issue("SYNA-1707");
    await link(blocker.id);
    source.unblockDescriptor = { owner: "board", action: "Wait for SYNA-1707" };
    await expect(validate()).resolves.toBeUndefined();
    expect(source.unblockDescriptor.owner).toBe("board");
  });
  it("refuses an unlinked issue reference", async () => {
    await issue("SYNA-1707");
    await expect(validate({ ...descriptor("Wait for SYNA-1707"), kind: "external" })).rejects.toMatchObject({ status: 422 });
  });
  it("accepts a typed outside wait and refuses an expired date", async () => {
    await expect(validate({ ...descriptor("Wait for the vendor response"), kind: "external" })).resolves.toBeUndefined();
    await expect(validate({ ...descriptor("Wait until the scheduled date"), kind: "date", until: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ status: 409 });
  });
  it.each(["SYNA-1933", "SYNA-1929", "SYNA-1910", "SYNA-927"])("requires an actual target on %s without a descriptor", async identifier => {
    source.identifier = identifier;
    await expect(validate()).rejects.toMatchObject({ status: 422 });
  });
  it("retains the old guard when the integrity switch is disabled", async () => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "false");
    const blocker = await issue("SYNA-1707");
    await expect(validate(descriptor(), [blocker.id])).rejects.toMatchObject({ status: 409 });
  });

  it.each(["done", "cancelled"])("releases the last %s blocker in the status transaction", async status => {
    const blocker = await issue("SYNA-1780");
    await link(blocker.id);
    await db.update(issues).set({ status: "blocked", unblockDescriptor: descriptor("Wait for SYNA-1780") }).where(eq(issues.id, source.id));
    await svc.update(blocker.id, { status });
    expect(await svc.getById(source.id)).toMatchObject({ status: "todo", unblockDescriptor: null, assigneeAgentId: agentId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, source.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBeNull();
  });
  it.each(["route", "workspace.finalize", "issue_graph_liveness.backstop"] as const)(
    "keeps distinct wake keys for two cycles through %s", async producer => {
      const blocker = await issue("SYNA-1780");
      const keys: string[] = [];
      const enqueueWakeup = vi.fn(async (_agentId: string, opts?: { reason?: string | null; idempotencyKey?: string | null }) => {
        if (opts?.reason !== "issue_blockers_resolved") return null;
        keys.push(opts.idempotencyKey!);
        await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
          reason: opts.reason, idempotencyKey: opts.idempotencyKey, status: "completed" });
        return (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning())[0]!;
      });
      const recovery = recoveryService(db, { enqueueWakeup });
      routeHeartbeat.wakeup.mockImplementation(enqueueWakeup);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "board", companyIds: [companyId], isInstanceAdmin: true,
          source: "local_implicit" };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);

      for (const cycle of [new Date("2026-04-01T12:00:00Z"), new Date("2026-08-01T12:00:00Z")]) {
        await svc.update(blocker.id, { status: "todo" });
        await svc.update(source.id, { status: "blocked", blockedByIssueIds: [blocker.id] });
        // Pin distinct cycle times without changing the production clock.
        await db.update(issues).set({ blockedTransitionAt: cycle }).where(eq(issues.id, source.id));
        const expectedKey = buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: source.id,
          blockerIssueIds: [blocker.id], blockedTransitionAt: cycle });
        if (producer === "route") {
          const res = await request(app).patch(`/api/issues/${blocker.id}`).send({ status: "done" });
          expect(res.status, JSON.stringify(res.body)).toBe(200);
        } else {
          // Simulate a dependency that becomes ready after the status event.
          // Finalization and the periodic check use this shared producer.
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
          const result = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId,
            blockerIssueId: producer === "workspace.finalize" ? blocker.id : undefined, source: producer });
          expect(result).toMatchObject({ healed: 1, existingWakeSkipped: 0 });
        }
        await vi.waitFor(() => expect(keys.at(-1)).toBe(expectedKey));
        const released = (await svc.getById(source.id))!;
        expect(released.status).toBe("todo");
        expect(released.blockedTransitionAt).toEqual(cycle);
        const [dependent] = await svc.listWakeableBlockedDependents(blocker.id);
        expect(dependent?.blockedTransitionAt).toEqual(cycle);
        expect(buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent!.id,
          blockerIssueIds: dependent!.blockerIssueIds, blockedTransitionAt: dependent!.blockedTransitionAt })).toBe(expectedKey);
        if (producer === "route") {
          const res = await request(app).patch(`/api/issues/${blocker.id}`).send({ status: "done" });
          expect(res.status).toBe(200);
        } else {
          await recovery.reconcileResolvedDependencyWakeBackstop({ companyId, source: producer });
        }
      }
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    }, 30_000,
  );

  it("waits until both blockers end", async () => {
    const first = await issue("SYNA-1780");
    const last = await issue("SYNA-1858");
    await svc.update(source.id, { status: "blocked", blockedByIssueIds: [first.id, last.id] });
    await svc.update(first.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked" });
    await svc.update(last.id, { status: "cancelled" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "todo", unblockDescriptor: null });
  });
  it("does not report cancelled dependencies as live blockers", async () => {
    const cancelled = await issue("SYNA-1858", "cancelled");
    expect(classifyIssueGraphLiveness({
      issues: [source, cancelled],
      relations: [{ companyId, blockerIssueId: cancelled.id, blockedIssueId: source.id }],
      agents: [{ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" }],
    })).toEqual([]);
  });
  it("keeps an open bridge hold after the reviewer completes", async () => {
    const reviewer = await issue("SYNA-2025", "in_progress");
    const hold = await issue("SYNA-2024", "backlog", { parentId: source.id,
      title: `Review hold: ${source.identifier} (bridge-owned, do not edit)` });
    await svc.update(source.id, { status: "blocked", blockedByIssueIds: [reviewer.id] });
    await svc.update(reviewer.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    const relations = await svc.getRelationSummaries(source.id);
    expect(relations.blockedBy.map(row => row.id)).toContain(hold.id);
    expect(await svc.listWakeableBlockedDependents(reviewer.id)).toEqual([]);
    const state = await collectDispositionRepairSourceState(db, { issue: (await svc.getById(source.id))! });
    expect(state.hasDurableWaitingPath).toBe(true);
  });
  it("preserves an outside wait when the last blocker ends", async () => {
    const blocker = await issue("SYNA-1780");
    await link(blocker.id);
    await svc.update(source.id, { status: "blocked", unblockDescriptor: { ...descriptor("Wait for the vendor"), kind: "external" } });
    await svc.update(blocker.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked" });
    expect(await hasNonDependencyBlockedWait(db, source.id)).toBe(true);
    expect(await svc.listWakeableBlockedDependents(blocker.id)).toEqual([]);
  });
  it("preserves a pending human card when the last blocker ends", async () => {
    const blocker = await issue("SYNA-1780");
    await link(blocker.id);
    await db.insert(issueThreadInteractions).values({ companyId, issueId: source.id, kind: "request_confirmation",
      status: "pending", title: "Approve the operation", payload: {}, continuationPolicy: "wake_assignee" });
    await svc.update(source.id, { status: "blocked" });
    await svc.update(blocker.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked" });
    expect(await hasNonDependencyBlockedWait(db, source.id)).toBe(true);
    expect(await svc.listWakeableBlockedDependents(blocker.id)).toEqual([]);
  });

  it.each(["todo", "in_progress", "done", "cancelled"])("keeps %s attention empty without unresolved blockers", async status => {
    await db.update(issues).set({ status }).where(eq(issues.id, source.id));
    source = (await svc.getById(source.id))!;
    const emptyAttention = { state: "none", reason: null, unresolvedBlockerCount: 0,
      terminalBlockerIssueId: null, terminalBlocker: null, directBlockerIssueId: null };
    expect((await svc.listBlockerAttention(companyId, [source])).get(source.id)).toMatchObject(emptyAttention);
    const blocker = await issue("SYNA-1858", "cancelled");
    await link(blocker.id);
    expect((await svc.listBlockerAttention(companyId, [source])).get(source.id)).toMatchObject(emptyAttention);
  });

  it.each(["SYNA-582", "SYNA-555", "SYNA-605", "SYNA-1445"])("counts explicit links on %s in every status", async identifier => {
    const blocker = await issue(identifier, "todo", { assigneeAgentId: agentId });
    await link(blocker.id);
    const attention = await svc.listBlockerAttention(companyId, [source]);
    expect(attention.get(source.id)?.unresolvedBlockerCount).toBe(1);
    expect((await svc.getRelationSummaries(source.id)).blockedBy.map(row => row.id)).toEqual([blocker.id]);
  });
  it.each(["SYNA-1150", "SYNA-927"])("does not infer blocker links from children on %s", async identifier => {
    await db.update(issues).set({ status: "blocked", identifier }).where(eq(issues.id, source.id));
    await issue("SYNA-1707", "todo", { parentId: source.id });
    source = (await db.select().from(issues).where(eq(issues.id, source.id)))[0]!;
    const attention = await svc.listBlockerAttention(companyId, [source]);
    expect(attention.get(source.id)?.unresolvedBlockerCount).toBe(0);
    expect((await svc.getRelationSummaries(source.id)).blockedBy).toEqual([]);
  });
});
