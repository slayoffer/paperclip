import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";

// The route import needs additional time on a loaded test host.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async (): Promise<{ id: string } | null> => null));
const mockLogActivity = vi.hoisted(() => vi.fn(async (_db: unknown, _entry: Record<string, unknown>) => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    getActiveRunForAgent: vi.fn(async () => null),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

async function createApp() {
  const emptyRows: unknown[] = [];
  const whereResult = {
    limit: vi.fn(async () => emptyRows),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(emptyRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it.each(["done", "cancelled"])("wakes dependents when the final blocker becomes %s", async status => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status,
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });

  function issueRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Issue",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      blockedTransitionAt: null,
      labels: [],
      labelIds: [],
      ...overrides,
    };
  }

  it.each([false, true])("records dependency emission only after successful admission: %s", async admitted => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      { id: "issue-2", assigneeAgentId: "agent-2", blockerIssueIds: ["issue-1"] },
    ]);
    mockWakeup.mockResolvedValue(admitted ? { id: "admitted-run" } : null);
    const response = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(response.status).toBe(200);
    await vi.waitFor(() => { expect(mockWakeup).toHaveBeenCalledTimes(1); });
    // Let the completion callback finish before inspecting its activity rows.
    await new Promise(resolve => setImmediate(resolve));
    const emitted = mockLogActivity.mock.calls.filter(([, entry]) =>
      (entry as { action: string }).action === "issue.blockers_resolved_wake_emitted");
    expect(emitted).toHaveLength(admitted ? 1 : 0);
  });

  it("wakes a Release-like dependent after a terminal reset using the current blocked cycle", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const releaseBlockedAt = new Date("2026-08-01T15:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          companyId: "company-1",
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledTimes(1);
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-release",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: releaseIssueId,
            blockerIssueIds: [reviewIssueId],
            blockedTransitionAt: releaseBlockedAt,
          }),
          payload: expect.objectContaining({
            issueId: releaseIssueId,
            resolvedBlockerIssueId: reviewIssueId,
            mutation: "blocker_done",
          }),
        }),
      );
    });
  });

  it("does not enqueue a second wake when the blocker is already done", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: new Date("2026-08-01T15:00:00.000Z"),
      },
    ]);

    const res = await request(await createApp()).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockIssueService.listWakeableBlockedDependents).not.toHaveBeenCalled();
  });

  it("wakes a QA-like chain one dependent at a time after each blocker completes", async () => {
    const reviewIssueId = "11111111-1111-4111-8111-111111111111";
    const releaseIssueId = "22222222-2222-4222-8222-222222222222";
    const qaIssueId = "33333333-3333-4333-8333-333333333333";
    const releaseBlockedAt = new Date("2026-08-02T10:00:00.000Z");
    const qaBlockedAt = new Date("2026-08-02T10:05:00.000Z");
    const app = await createApp();

    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "in_progress",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: reviewIssueId,
      identifier: "PAP-REVIEW",
      title: "Review",
      status: "done",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: releaseIssueId,
        assigneeAgentId: "agent-release",
        blockerIssueIds: [reviewIssueId],
        blockedTransitionAt: releaseBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${reviewIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-release",
      expect.objectContaining({
        payload: expect.objectContaining({ issueId: releaseIssueId }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: releaseIssueId,
          blockerIssueIds: [reviewIssueId],
          blockedTransitionAt: releaseBlockedAt,
        }),
      }),
    );

    mockWakeup.mockClear();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockClear();
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "blocked",
      assigneeAgentId: "agent-release",
      blockedTransitionAt: releaseBlockedAt,
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: releaseIssueId,
      identifier: "PAP-RELEASE",
      title: "Release",
      status: "done",
      assigneeAgentId: "agent-release",
    }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: qaIssueId,
        assigneeAgentId: "agent-qa",
        blockerIssueIds: [releaseIssueId],
        blockedTransitionAt: qaBlockedAt,
      },
    ]);

    expect((await request(app).patch(`/api/issues/${releaseIssueId}`).send({ status: "done" })).status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(1);
    });
    expect(mockWakeup).toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        payload: expect.objectContaining({
          issueId: qaIssueId,
          resolvedBlockerIssueId: releaseIssueId,
        }),
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: qaIssueId,
          blockerIssueIds: [releaseIssueId],
          blockedTransitionAt: qaBlockedAt,
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalledWith("agent-release", expect.anything());
  });

  it("restores a blocked-and-ready dependent under the new blocked cycle key", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const blockedTransitionAt = new Date("2026-08-03T18:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "done",
      assigneeAgentId: "agent-2",
    }));
    mockIssueService.update.mockResolvedValue(issueRecord({
      id: parentIssueId,
      identifier: "PAP-200",
      title: "Blocked after completion",
      status: "blocked",
      assigneeAgentId: "agent-2",
      blockedTransitionAt,
    }));
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockFindExistingIssueBlockersResolvedWakeForReadyState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dependentIssueId: parentIssueId,
          blockerIssueIds: [childIssueId],
          blockedTransitionAt,
        }),
      );
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
            dependentIssueId: parentIssueId,
            blockerIssueIds: [childIssueId],
            blockedTransitionAt,
          }),
          payload: expect.objectContaining({
            mutation: "blocked_dependency_restored",
          }),
        }),
      );
    });
  });

  it("does not emit a dependency wake when an unresolved or cancelled blocker remains", async () => {
    mockIssueService.getById.mockResolvedValue(issueRecord({ status: "in_progress" }));
    mockIssueService.update.mockResolvedValue(issueRecord({ status: "done" }));
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
