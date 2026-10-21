import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listReviewAttention: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS: 5 * 60 * 1000,
}));

function createApp() {
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
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const legacyProjectLinkedIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  workMode: "planning",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

describe("light issue reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueService.getById.mockResolvedValue(legacyProjectLinkedIssue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    const emptyQuery: any = {};
    emptyQuery.from = vi.fn(() => emptyQuery);
    emptyQuery.innerJoin = vi.fn(() => emptyQuery);
    emptyQuery.leftJoin = vi.fn(() => emptyQuery);
    emptyQuery.where = vi.fn(() => emptyQuery);
    emptyQuery.orderBy = vi.fn(() => emptyQuery);
    emptyQuery.limit = vi.fn(async () => []);
    emptyQuery.then = (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    mockDb.select.mockReturnValue(emptyQuery);
    mockDb.execute.mockResolvedValue([]);
    mockProjectService.getById.mockResolvedValue({
      id: legacyProjectLinkedIssue.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    );
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
  });

  it("returns issue fields without derived reads", async () => {
    const res = await request(createApp()).get(`/api/issues/${legacyProjectLinkedIssue.id}?view=light`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(legacyProjectLinkedIssue.id);
    expect(res.body.goalId).toBeNull();
    expect(res.body.labels).toEqual([]);
    expect(res.headers["server-timing"]).toContain("lookup");
    for (const key of ["ancestors", "relatedWork", "documents", "project", "goal", "blockerAttention"]) {
      expect(res.body).not.toHaveProperty(key);
    }
    expect(mockAccessService.decide).toHaveBeenCalled();
    expect(mockIssueService.getAncestors).not.toHaveBeenCalled();
    expect(mockIssueReferenceService.listIssueReferenceSummary).not.toHaveBeenCalled();
    expect(mockDocumentsService.getIssueDocumentPayload).not.toHaveBeenCalled();
    expect(mockProjectService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.listBlockerAttention).not.toHaveBeenCalled();
  });

  it("enforces authorization before returning a light issue", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_test", explanation: "Access denied" });
    const res = await request(createApp()).get(`/api/issues/${legacyProjectLinkedIssue.id}?view=light`);
    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty("title");
  });

  it("returns 404 for a missing issue", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const res = await request(createApp()).get(`/api/issues/${legacyProjectLinkedIssue.id}?view=light`);
    expect(res.status).toBe(404);
  });
});
