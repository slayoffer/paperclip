import request from "supertest";
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildIssueChanges } from "../services/issue-change-receipt.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import {
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
} from "./issue-activity-events-routes.fixture.ts";

describe("issue activity event routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: null,
      consentEnabledNow: false,
      sharingEnabled: false,
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
  });

  it("returns a field-change receipt and omits a requested no-op field", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      issueUpdateWithReceipt(issue, patch));

    const changed = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });
    expect(changed.status).toBe(200);
    expect(changed.body.changes).toEqual({
      priority: { from: "medium", to: "high" },
    });

    const noOp = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ title: issue.title });
    expect(noOp.status).toBe(200);
    expect(noOp.body.changes).not.toHaveProperty("title");
  });

  it("echoes scalar blocker state and summaries when setting and clearing blockers", async () => {
    const issue = makeIssue();
    const blockerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let blockedByIssueIds: string[] = [];
    const relationSummaries = () => ({
      blockedBy: blockedByIssueIds.map((id) => ({
        id,
        identifier: "PAP-10",
        title: "Blocker",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      })),
      blocks: [],
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getRelationSummaries.mockImplementation(async () => relationSummaries());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      const from = blockedByIssueIds;
      blockedByIssueIds = [...new Set(patch.blockedByIssueIds as string[])].sort();
      return {
        ...issueUpdateWithReceipt(issue, patch),
        blockedByIssueIds,
        changes: buildIssueChanges(issue, issue, {
          blockedByIssueIds: { from, to: blockedByIssueIds },
        }),
      };
    });

    const setResponse = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ blockedByIssueIds: [blockerId] });
    expect(setResponse.status).toBe(200);
    expect(setResponse.body).toMatchObject({
      blockedByIssueIds: [blockerId],
      blockedBy: [{ id: blockerId }],
      blocks: [],
      changes: { blockedByIssueIds: { from: [], to: [blockerId] } },
    });

    const clearResponse = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ blockedByIssueIds: [] });
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body).toMatchObject({
      blockedByIssueIds: [],
      blockedBy: [],
      blocks: [],
      changes: { blockedByIssueIds: { from: [blockerId], to: [] } },
    });
  });

  it("truncates long text receipt values to 200 characters and marks them updated", async () => {
    const issue = {
      ...makeIssue(),
      title: "a".repeat(240),
      description: "b".repeat(240),
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      issueUpdateWithReceipt(issue, patch));

    const response = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "c".repeat(240), description: "d".repeat(240) });

    expect(response.status).toBe(200);
    expect(response.body.changes).toEqual({
      title: { from: "a".repeat(200), to: "c".repeat(200), updated: true },
      description: { from: "b".repeat(200), to: "d".repeat(200), updated: true },
    });
  });

  it("returns only the minimal receipt fields when requested", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      issueUpdateWithReceipt(issue, patch));

    const response = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .set("Prefer", "respond-async, return=minimal")
      .send({ priority: "high" });

    expect(response.status).toBe(200);
    expect(response.headers["preference-applied"]).toBe("return=minimal");
    expect(response.body).toEqual({
      id: issue.id,
      identifier: issue.identifier,
      updatedAt: "2026-07-30T12:01:00.000Z",
      changes: { priority: { from: "medium", to: "high" } },
      comment: null,
    });
  });

  it("preserves the default full response body with additive receipt fields", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      issueUpdateWithReceipt(issue, patch));

    const response = await request(await createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ priority: "high" });

    expect(response.status).toBe(200);
    expect(response.headers["preference-applied"]).toBeUndefined();
    expect(response.body).toMatchInlineSnapshot(`
      {
        "assigneeAgentId": "22222222-2222-4222-8222-222222222222",
        "assigneeUserId": null,
        "changes": {
          "priority": {
            "from": "medium",
            "to": "high",
          },
        },
        "comment": null,
        "companyId": "company-1",
        "createdByUserId": "local-board",
        "description": null,
        "executionPolicy": null,
        "executionState": null,
        "id": "11111111-1111-4111-8111-111111111111",
        "identifier": "PAP-580",
        "priority": "high",
        "status": "todo",
        "title": "Activity event issue",
        "updatedAt": "2026-07-30T12:01:00.000Z",
      }
    `);
  });

  it("logs blocker activity with added and removed issue summaries", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    const previousRelations = {
      blockedBy: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          identifier: "PAP-10",
          title: "Old blocker",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    };
    const nextRelations = {
      blockedBy: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          identifier: "PAP-11",
          title: "New blocker",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    };
    let relationLookupCount = 0;
    mockIssueService.getRelationSummaries.mockImplementation(async () => {
      relationLookupCount += 1;
      return relationLookupCount === 1 ? previousRelations : nextRelations;
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ blockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.blockers_updated",
          details: expect.objectContaining({
            addedBlockedByIssueIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
            removedBlockedByIssueIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
            addedBlockedByIssues: [
              {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                identifier: "PAP-11",
                title: "New blocker",
              },
            ],
            removedBlockedByIssues: [
              {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                identifier: "PAP-10",
                title: "Old blocker",
              },
            ],
          }),
        }),
      );
    });
  }, 15_000);

  it("logs readable workspace change activity details for issue updates", async () => {
    const previousProjectWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const nextExecutionWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const issue = {
      ...makeIssue(),
      projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      projectWorkspaceId: previousProjectWorkspaceId,
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
      changes: {
        executionWorkspaceId: {
          from: issue.executionWorkspaceId,
          to: nextExecutionWorkspaceId,
        },
      },
    }));

    const dbMock = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: async () => {
            const tableName = getTableName(table as Parameters<typeof getTableName>[0]);
            if (tableName === "project_workspaces") {
              return [{ id: previousProjectWorkspaceId, name: "Main workspace" }];
            }
            if (tableName === "execution_workspaces") {
              return [{ id: nextExecutionWorkspaceId, name: "Feature workspace" }];
            }
            return [];
          },
        }),
      })),
    };

    const res = await request(await createApp(dbMock))
      .patch(`/api/issues/${issue.id}`)
      .send({ executionWorkspaceId: nextExecutionWorkspaceId });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.updated",
          details: expect.objectContaining({
            executionWorkspaceId: nextExecutionWorkspaceId,
            workspaceChange: {
              from: {
                label: "Main workspace",
                projectWorkspaceId: previousProjectWorkspaceId,
                executionWorkspaceId: null,
                mode: "shared_workspace",
              },
              to: {
                label: "Feature workspace",
                projectWorkspaceId: previousProjectWorkspaceId,
                executionWorkspaceId: nextExecutionWorkspaceId,
                mode: "shared_workspace",
              },
            },
            _previous: expect.objectContaining({
              executionWorkspaceId: null,
            }),
          }),
        }),
      );
    });
  });

  it("logs successful_run_handoff_resolved when an in_progress issue transitions to done with a pending required handoff", async () => {
    const issue = { ...makeIssue(), status: "in_progress" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const handoffActivityRow = {
      entityId: issue.id,
      action: "issue.successful_run_handoff_required",
      agentId: issue.assigneeAgentId,
      runId: "run-1",
      details: {
        sourceRunId: "run-1",
        correctiveRunId: "run-2",
      },
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    };
    const dbMock = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [handoffActivityRow],
          }),
        }),
      }),
    };

    const res = await request(await createApp(dbMock))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.successful_run_handoff_resolved",
          entityId: issue.id,
          details: expect.objectContaining({
            identifier: "PAP-580",
            sourceRunId: "run-1",
            correctiveRunId: "run-2",
            resolvedByStatus: "done",
          }),
        }),
      );
    });
  });

  it("does not log successful_run_handoff_resolved when status stays in_progress", async () => {
    const issue = { ...makeIssue(), status: "in_progress" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const dbMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [],
          }),
        }),
      }),
    };

    const res = await request(await createApp(dbMock))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Updated title" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.successful_run_handoff_resolved" }),
    );
  });

  it("logs explicit reviewer and approver activity when execution policy participants change", async () => {
    const existingPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" }],
        },
      ],
    })!;
    const nextPolicy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue(),
      executionPolicy: existingPolicy,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      executionPolicy: patch.executionPolicy,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ executionPolicy: nextPolicy });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.reviewers_updated",
          details: expect.objectContaining({
            participants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
            addedParticipants: [{ type: "agent", agentId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", userId: null }],
            removedParticipants: [{ type: "agent", agentId: "11111111-2222-4333-8444-555555555555", userId: null }],
          }),
        }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.approvers_updated",
          details: expect.objectContaining({
            participants: [{ type: "user", agentId: null, userId: "local-board" }],
            addedParticipants: [{ type: "user", agentId: null, userId: "local-board" }],
            removedParticipants: [{ type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa", userId: null }],
          }),
        }),
      );
    });
  });
});
