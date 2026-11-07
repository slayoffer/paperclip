import { eq, sql } from "drizzle-orm";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { expect, it, vi, type Mock } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueRelations, issues, nativeRunFinalizations, statusDecisions, type Db } from "@paperclipai/db";
import type { issueService } from "../services/issues.js";
import { seedNativeDependencyCompletion } from "./helpers/native-dependency-completion.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { dependencyCompletionWakeKey } from "../services/native-runtime/dependency-completion-wake.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import * as parentCompletion from "../services/issue-parent-completion.js";

type Context = {
  db: Db;
  svc: ReturnType<typeof issueService>;
  companyId: string;
  agentId: string;
  blocker: typeof issues.$inferSelect;
  dependent: typeof issues.$inferSelect;
  heartbeat: { wakeup: Mock };
  intents: () => Promise<(typeof agentWakeupRequests.$inferSelect)[]>;
  recover: () => Promise<unknown>;
  markRollbackTrigger: () => void;
};

export function nativeDependencyCompletionCases(context: () => Context) {
  it.each([false, true])("retains native wake keys with integrity=%s", integrity => {
    const { blocker, dependent } = context();
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", String(integrity));
    const input = { ...dependent, blockerIssueIds: [blocker.id] };
    for (const parent of [false, true]) {
      expect(dependencyCompletionWakeKey(input, blocker.id, parent)).toBe(integrity
        ? buildIssueBlockersResolvedWakeStateKey({ dependentIssueId: dependent.id, ...input })
        : parent ? `issue_children_completed:${dependent.id}:${blocker.id}`
          : `issue_blockers_resolved:${dependent.id}:${blocker.id}`);
    }
  });

  it("native completion rolls back dependency wakes after status projection", async () => {
    const { db, svc, companyId, agentId, blocker, dependent, heartbeat, intents, markRollbackTrigger } = context();
    const runId = await seedNativeDependencyCompletion(db, { companyId, issueId: blocker.id, agentId });
    await db.execute(sql`CREATE OR REPLACE FUNCTION reject_dependency_commit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'outer dependency rollback'; END; $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER reject_dependency_commit BEFORE UPDATE ON status_decisions
      FOR EACH ROW EXECUTE FUNCTION reject_dependency_commit()`);
    markRollbackTrigger();
    const result = await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    expect(result).toMatchObject({ phase: "retryable_failure" });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator?.failureDetail?.message).toContain('update "status_decisions"');
    expect((await svc.getById(blocker.id))?.status).toBe("todo");
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
    expect(await intents()).toEqual([]);
    expect(await db.select().from(statusDecisions)).toEqual([]);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("sends one wake when native completion resolves its parent dependency", async () => {
    const { db, companyId, agentId, blocker, dependent, heartbeat, intents, recover } = context();
    await db.update(issues).set({ parentId: dependent.id }).where(eq(issues.id, blocker.id));
    const runId = await seedNativeDependencyCompletion(db, { companyId, issueId: blocker.id, agentId });
    expect(await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" }))
      .toMatchObject({ phase: "committed" });
    await recover();
    const queued = (await db.select().from(agentWakeupRequests))
      .filter(row => row.requestedByActorId !== "blocked-dependency-release");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ reason: "issue_children_completed", payload: {
      childIssueIds: [blocker.id], childIssueSummaries: [expect.objectContaining({ id: blocker.id })],
    } });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
    await db.update(agentWakeupRequests).set({ status: "completed" })
      .where(eq(agentWakeupRequests.id, queued[0]!.id));
    await recover();
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("native completion dispatches dependency wakes only after the outer commit", async () => {
    const { db, svc, companyId, agentId, blocker, dependent, heartbeat, intents } = context();
    const runId = await seedNativeDependencyCompletion(db, { companyId, issueId: blocker.id, agentId });
    const finalResult = await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    expect(finalResult).toMatchObject({ phase: "committed" });
    expect((await svc.getById(blocker.id))?.status).toBe("done");
    expect((await svc.getById(dependent.id))?.status).toBe("todo");
    expect(await db.select().from(statusDecisions)).toEqual([expect.objectContaining({ applicationState: "applied" })]);
    const queued = (await db.select().from(agentWakeupRequests)).filter(row => row.requestedByActorId !== "blocked-dependency-release");
    expect(queued).toEqual([expect.objectContaining({ reason: "issue_blockers_resolved", status: "queued" })]);
    // Native completion already queued this wake in its transaction.
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
  });

  it.each([false, true])("uses the dependency path for a linked parent with integrity=%s", async integrity => {
    const { db, svc, blocker, dependent } = context();
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", String(integrity));
    await db.update(issues).set({ parentId: dependent.id, status: "done" }).where(eq(issues.id, blocker.id));
    const parent = await svc.getWakeableParentAfterChildCompletion(dependent.id,
      { issueId: blocker.id, summary: "Completed child result" });
    if (integrity) expect(parent).toBeNull();
    else expect(parent).toMatchObject({ id: dependent.id,
      childIssueSummaries: [expect.objectContaining({ summary: "Completed child result" })] });
  });

  it("preserves child summaries when the parent has no explicit dependency", async () => {
    const { db, svc, blocker, dependent } = context();
    await db.delete(issueRelations);
    await db.update(issues).set({ parentId: dependent.id, status: "done" }).where(eq(issues.id, blocker.id));
    expect(await svc.getWakeableParentAfterChildCompletion(dependent.id,
      { issueId: blocker.id, summary: "Completed child result" })).toMatchObject({ id: dependent.id,
      childIssueSummaries: [expect.objectContaining({ summary: "Completed child result" })] });
  });

  it("preserves the final report for a completed onboarding parent", async () => {
    const { db, svc, blocker, dependent } = context();
    await db.update(issues).set({ status: "done", originKind: "onboarding_first_task" })
      .where(eq(issues.id, dependent.id));
    await db.update(issues).set({ parentId: dependent.id, status: "done" }).where(eq(issues.id, blocker.id));
    expect(await svc.getWakeableParentAfterChildCompletion(dependent.id,
      { issueId: blocker.id, summary: "Completed child result" })).toMatchObject({
      id: dependent.id, onboardingCompletion: true,
      childIssueSummaries: [expect.objectContaining({ summary: "Completed child result" })],
    });
  });

  it("sends one durable HTTP parent wake and preserves child summaries", async () => {
    const { db, companyId, agentId, blocker, dependent, heartbeat, intents, recover } = context();
    await db.update(issues).set({ parentId: dependent.id }).where(eq(issues.id, blocker.id));
    await db.insert(issueComments).values({ companyId, issueId: blocker.id, body: "Child delivery is complete." });
    heartbeat.wakeup.mockImplementation(async (target, opts) => {
      await db.insert(agentWakeupRequests).values({ companyId, agentId: target, source: "automation",
        status: "completed", reason: opts.reason, idempotencyKey: opts.idempotencyKey, payload: opts.payload });
      return (await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning())[0]!;
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board", companyIds: [companyId], isInstanceAdmin: true,
        source: "local_implicit" };
      next();
    });
    const parentProbe = vi.spyOn(parentCompletion, "getWakeableParentAfterChildCompletion");
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await request(server).patch(`/api/issues/${blocker.id}`).send({ status: "done" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Wait for the route's detached parent check before fixture cleanup.
      const routeCheck = () => parentProbe.mock.calls.findIndex(call => call[1] === dependent.id && call[3] !== true);
      await vi.waitFor(() => expect(routeCheck()).toBeGreaterThanOrEqual(0));
      expect(await parentProbe.mock.results[routeCheck()]!.value).toBeNull();
      await vi.waitFor(() => expect(heartbeat.wakeup).toHaveBeenCalledTimes(1));
      expect(heartbeat.wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
        reason: "issue_children_completed", payload: expect.objectContaining({ issueId: dependent.id,
          childIssueSummaries: [expect.objectContaining({ id: blocker.id, summary: "Child delivery is complete." })] }),
      }));
      await recover();
      expect(heartbeat.wakeup).toHaveBeenCalledTimes(1);
      expect((await intents())[0]?.status).toBe("completed_dependency_dispatch");
      expect((await db.select().from(agentWakeupRequests))
        .filter(row => row.requestedByActorId !== "blocked-dependency-release")).toHaveLength(1);
    } finally {
      parentProbe.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("preserves an outside parent wait after an unlinked child completes", async () => {
    const { db, svc, agentId, blocker, dependent } = context();
    await db.delete(issueRelations);
    await db.update(issues).set({ parentId: dependent.id, status: "done" }).where(eq(issues.id, blocker.id));
    await db.update(issues).set({ unblockDescriptor: {
      kind: "external", owner: { agentId }, action: "Wait for the vendor response",
    } }).where(eq(issues.id, dependent.id));
    expect(await svc.getWakeableParentAfterChildCompletion(dependent.id,
      { issueId: blocker.id, summary: null })).toBeNull();
    expect((await svc.getById(dependent.id))?.status).toBe("blocked");
  });
}
