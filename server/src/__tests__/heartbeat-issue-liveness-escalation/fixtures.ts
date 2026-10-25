import { randomUUID } from "node:crypto";
import { companies, companyMemberships, agents, projects, projectWorkspaces,
  executionWorkspaces, issues, issueRelations, workspaceOperations, type Db } from "@paperclipai/db";

export function createLivenessFixtures(getDb: () => Db) {
  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const db = getDb();
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  return { seedResolvedDependencyBackstopFixture };
}
