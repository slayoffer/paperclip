import express from "express";
import { vi } from "vitest";
import { buildIssueChanges } from "../services/issue-change-receipt.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async ({ action }: { action: string }) => ({
    action, allowed: action === "issue:read", reason: "allow_default", explanation: "Fixture task is readable",
  })),
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
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
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => mockFeedbackService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/routines.js", () => ({
    routineService: () => mockRoutineService,
  }));

  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
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
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

function createEmptyRelationReadDb() {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn(async () => []),
  };
  return {
    select: vi.fn().mockReturnValue(query),
  };
}

async function createApp(db: unknown = createEmptyRelationReadDb()) {
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
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Activity event issue",
    description: null,
    priority: "medium",
    executionPolicy: null,
    executionState: null,
    updatedAt: new Date("2026-07-30T12:00:00.000Z"),
  };
}

function issueUpdateWithReceipt(issue: ReturnType<typeof makeIssue>, patch: Record<string, unknown>) {
  const {
    actorAgentId: _actorAgentId,
    actorRunId: _actorRunId,
    actorRunStopId: _actorRunStopId,
    actorUserId: _actorUserId,
    blockedByIssueIds: _blockedByIssueIds,
    blockedWaitCommentBody: _blockedWaitCommentBody,
    ...issuePatch
  } = patch;
  const updated = {
    ...issue,
    ...issuePatch,
    updatedAt: new Date("2026-07-30T12:01:00.000Z"),
  };
  return {
    ...updated,
    changes: buildIssueChanges(issue, updated),
  };
}

export {
  mockIssueService,
  mockLogActivity,
  mockAccessService,
  mockHeartbeatService,
  mockFeedbackService,
  mockInstanceSettingsService,
  mockRoutineService,
  registerModuleMocks,
  createApp,
  makeIssue,
  issueUpdateWithReceipt,
};
