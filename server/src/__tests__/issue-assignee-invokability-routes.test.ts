import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PAUSED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const agentStatusById: Record<string, string> = {
  [AGENT_ACTOR_ID]: "idle",
  [PAUSED_AGENT_ID]: "paused",
  [IDLE_AGENT_ID]: "idle",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/external-objects.js", () => ({
  externalObjectService: () => ({ syncIssueSafely: async () => undefined, syncCommentSafely: async () => undefined }),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

type Actor = Record<string, unknown>;

function boardActor(): Actor {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ACTOR_ID,
    companyId: "company-1",
    source: "agent_key",
    runId: AGENT_RUN_ID,
  };
}

// Minimal chainable/thenable db stub: any query resolves to an empty row set.
// Run containment is mocked because this suite targets assignee invokability.
function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for", "update", "set", "insert", "values", "returning", "onConflictDoNothing"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  const database = { select: () => query, update: () => query,
    transaction: async (callback: (tx: unknown) => unknown) => callback(database) };
  return database;
}

function createApp(actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ACTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Invokability test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue assignee invokability guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.update.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockClear();
    mockObserveCrossIssueInfluence.mockClear();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
  });

  it("refuses an agent assigning an issue to a paused agent", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a child issue assigned to a paused agent", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Escalation for the manager",
        description: "Needs a decision",
        assigneeAgentId: PAUSED_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still allows an agent to assign to an invokable agent", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ assigneeAgentId: IDLE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID });

    expect(res.status, res.text).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows a board user to assign to a paused agent deliberately", async () => {
    const existing = makeIssue({ assigneeAgentId: null });
    const updated = makeIssue({ assigneeAgentId: PAUSED_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status, res.text).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it.each([
    { assigneeAgentId: null, assigneeUserId: "local-board" },
    { assigneeAgentId: AGENT_ACTOR_ID, assigneeUserId: null },
  ])("keeps blocked assignment changes quiet from $assigneeUserId / $assigneeAgentId", async previous => {
    const existing = makeIssue({ ...previous, status: "blocked" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));
    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID, assigneeUserId: null });
    await new Promise(resolve => setImmediate(resolve));
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: "blocked", assigneeAgentId: IDLE_AGENT_ID });
    expect(mockIssueService.update.mock.calls[0][1].status).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the new assignee when the blocked PATCH explicitly sets todo", async () => {
    const existing = makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "local-board" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));
    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID, assigneeUserId: null, status: "todo" });
    await new Promise(resolve => setImmediate(resolve));
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("todo");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(IDLE_AGENT_ID,
      expect.objectContaining({ reason: "issue_assigned" }));
  });

  it.each([false, true])("requires explicit resume for reassignment with a comment (resume=%s)", async resume => {
    const existing = makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "local-board" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockImplementation(async (_id, patch) => ({ ...existing, ...patch }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", issueId: existing.id,
      companyId: existing.companyId, body: "Assignment context" });
    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID, assigneeUserId: null, comment: "Assignment context", resume });
    await new Promise(resolve => setImmediate(resolve));
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe(resume ? "todo" : "blocked");
    if (resume) {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(IDLE_AGENT_ID,
        expect.objectContaining({ payload: expect.objectContaining({ resumeIntent: true }) }));
    } else expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
});

describe("agent delegation cycle guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
  });

  it("refuses an agent child assigned to the creator of an open ancestor", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      identifier: "PAP-100",
      parentId: null,
      createdByAgentId: IDLE_AGENT_ID,
      status: "in_progress",
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Delegation cycle");
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.findOpenAncestorCreatedByAgent).toHaveBeenCalledWith(parent.id, IDLE_AGENT_ID);
  });

  it("allows the same child when no open ancestor was created by the assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Legit subtask",
        description: "Fine",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalled();
  });

  it("does not consult the guard for board actors", async () => {
    const parent = makeIssue({ assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Human-created child",
        description: "Deliberate",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenAncestorCreatedByAgent).not.toHaveBeenCalled();
  });
});
