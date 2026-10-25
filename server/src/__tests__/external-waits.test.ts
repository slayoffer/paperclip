import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRelations, issues,
  issueThreadInteractions, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { assertBlockedIssueUpdate } from "../services/issue-blocked-validation.js";
import { assertAssigneeExternalWait, externalWaitDeadline } from "../services/external-wait.js";
import { hasNonDependencyBlockedWait } from "../services/blocked-state-integrity.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const heartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: heartbeat.wakeup,
  }) };
});

const DAY = 24 * 60 * 60 * 1000;
const wait = (action: string): IssueUnblockDescriptor => ({ kind: "external", owner: "board", action });
const deadline = (offset = DAY) => `Wait for the vendor response. deadline: ${new Date(Date.now() + offset).toISOString()}`;

describe("external wait deadline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts exactly seven days and refuses one millisecond more", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const issue = { assigneeAgentId: "owner" };
    expect(() => assertAssigneeExternalWait(issue, "owner", {}, wait(deadline(7 * DAY)))).not.toThrow();
    expect(() => assertAssigneeExternalWait(issue, "owner", {}, wait(deadline(7 * DAY + 1))))
      .toThrow("within seven days");
  });

  it.each([
    "Wait for the vendor", "deadline: tomorrow", "deadline: 2026-02-30T10:00:00Z",
    "deadline: 2026-10-27", "deadline: 2026-10-27T10:00:00",
    "deadline: 2026-10-27T10:00:00Z deadline: 2026-10-28T10:00:00Z",
  ])("refuses an invalid or ambiguous action: %s", action => {
    expect(externalWaitDeadline(wait(action))).toBeNull();
  });

  it("accepts an ISO offset and a multiline action", () => {
    expect(externalWaitDeadline(wait("Wait for the vendor.\ndeadline: 2026-10-27T10:00:00+10:00")))
      .toBe(Date.parse("2026-10-27T00:00:00Z"));
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("assignee external waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let companyId: string;
  let agentId: string;
  let source: typeof issues.$inferSelect;
  let runId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-external-waits-");
    db = createDb(database.connectionString);
    svc = issueService(db);
  }, 30_000);
  beforeEach(async () => {
    heartbeat.wakeup.mockReset().mockResolvedValue(null);
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
    vi.stubEnv("PAPERCLIP_SELF_BLOCK_GUARD", "true");
    vi.stubEnv("PAPERCLIP_PULL_QUEUE_ENABLED", "true");
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "External waits", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    runId = run!.id;
    [source] = await db.insert(issues).values({ companyId, identifier: "SYNA-3100", title: "External wait",
      status: "in_progress", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId }).returning();
  });
  afterEach(async () => {
    for (const table of [issueThreadInteractions, activityLog, issueComments, issueRelations, heartbeatRuns,
      agentWakeupRequests, issues, agents, companies]) await db.delete(table);
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });

  function app() {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = { type: "agent", companyId, agentId, runId, source: "agent_jwt" };
      next();
    });
    result.use("/api", issueRoutes(db, {} as never));
    result.use(errorHandler);
    return result;
  }

  function validate(descriptor: IssueUnblockDescriptor, update: { assigneeAgentId?: string | null } = {}, actorId = agentId) {
    return assertBlockedIssueUpdate({
      db, actor: { type: "agent", companyId, agentId: actorId, source: "agent_jwt" }, existing: source,
      updateFields: { status: "blocked", unblockDescriptor: descriptor, ...update },
      getDependencyReadiness: svc.getDependencyReadiness,
    });
  }

  it.each([false, true])("accepts the route request without a handoff or early wake, integrity=%s", async integrity => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", String(integrity));
    const unblockDescriptor = wait(deadline());
    const res = await request(app()).patch(`/api/issues/${source.id}`).send({ status: "blocked", unblockDescriptor });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "blocked", assigneeAgentId: agentId, unblockDescriptor });
    const stored = (await svc.getById(source.id))!;
    expect(stored).toMatchObject({ status: "blocked", unblockDescriptor });
    expect(await hasNonDependencyBlockedWait(db, source.id)).toBe(true);
    const state = await collectDispositionRepairSourceState(db, { issue: stored });
    expect(state).toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "recorded_wait" });
    expect(await db.select().from(issueComments)).toEqual([]);
    expect(await db.select().from(issueThreadInteractions)).toEqual([]);
    expect((await db.select().from(activityLog)).some(row => row.action === "issue.updated")).toBe(true);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toEqual([]);
  });

  it.each([
    ["missing deadline", () => wait("Wait for the vendor"), 422],
    ["invalid deadline", () => wait("deadline: invalid"), 422],
    ["expired deadline", () => wait(deadline(-DAY)), 422],
    ["current deadline", () => wait(deadline(0)), 422],
    ["late deadline", () => wait(deadline(8 * DAY)), 422],
    ["human kind", () => ({ ...wait(deadline()), kind: "human" as const }), 403],
    ["missing kind", () => ({ owner: "board" as const, action: deadline() }), 403],
    ["user owner", () => ({ ...wait(deadline()), owner: { userId: "board" } }), 403],
    ["other agent", () => ({ ...wait(deadline()), owner: { agentId: randomUUID() } }), 422],
  ] as const)("refuses %s without a mutation or wake", async (_name, descriptor, status) => {
    const res = await request(app()).patch(`/api/issues/${source.id}`).send({ status: "blocked", unblockDescriptor: descriptor() });
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(await svc.getById(source.id)).toMatchObject({ status: "in_progress", unblockDescriptor: null });
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("refuses an unassigned actor and an assignee change", async () => {
    await expect(validate(wait(deadline()), {}, randomUUID())).rejects.toMatchObject({ status: 403 });
    await expect(validate(wait(deadline()), { assigneeAgentId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(validate(wait(deadline()), { assigneeAgentId: null })).rejects.toMatchObject({ status: 403 });
    await expect(validate(wait(deadline()), { assigneeAgentId: agentId })).resolves.toBeUndefined();
  });

  it("keeps the board's existing external descriptors compatible", async () => {
    await expect(assertBlockedIssueUpdate({
      db, actor: { type: "board", source: "local_implicit" }, existing: source,
      updateFields: { status: "blocked", unblockDescriptor: wait("Wait for the vendor") },
      getDependencyReadiness: svc.getDependencyReadiness,
    })).resolves.toBeUndefined();
  });

  it("keeps the external wait when a dependency completes", async () => {
    const [blocker] = await db.insert(issues).values({ companyId, title: "Dependency", status: "todo" }).returning();
    await svc.update(source.id, { status: "blocked", blockedByIssueIds: [blocker!.id], unblockDescriptor: wait(deadline()) });
    await svc.update(blocker!.id, { status: "done" });
    expect(await svc.getById(source.id)).toMatchObject({ status: "blocked" });
    expect(await svc.listWakeableBlockedDependents(blocker!.id)).toEqual([]);
  });
});
