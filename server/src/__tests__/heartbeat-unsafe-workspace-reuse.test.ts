import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, executionWorkspaces, issues, issueThreadInteractions, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));
const gitExec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await gitExec("git", args, { cwd })).stdout.trim();
}
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("dispatch after unsafe workspace reuse", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unsafe-reuse-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-unsafe-reuse-dispatch-"));
  }, 60_000);
  afterAll(async () => {
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await tempDb?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("dispatches in a new bound workspace and preserves the foreign row", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    await git(root, "init", "-b", "base");
    await git(root, "config", "user.name", "Fixture");
    await git(root, "config", "user.email", "fixture@example.test");
    await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "Initial fixture");
    const parent = path.join(root, "parent");
    await git(root, "worktree", "add", "-b", "parent", parent);
    await fs.writeFile(path.join(parent, "tracked.txt"), "foreign work\n");
    await git(parent, "add", "tracked.txt");
    const parentStatus = await git(parent, "status", "--porcelain");
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(authUsers).values({ id: "reuse-user", name: "Fixture", email: "fixture@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: "SAFE", defaultResponsibleUserId: "reuse-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId,
      name: "Primary", cwd: root, repoRef: "base", isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: sourceIssueId, companyId, projectId, title: "Foreign work" });
    await db.insert(executionWorkspaces).values({ id: foreignWorkspaceId, companyId, projectId, projectWorkspaceId,
      sourceIssueId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Foreign",
      status: "active", cwd: parent, providerType: "git_worktree", providerRef: parent, branchName: "parent", baseRef: "base" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId,
      title: "Resume child", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "reuse-user",
      identifier: "SAFE-2", executionWorkspaceId: foreignWorkspaceId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      assigneeAdapterOverrides: { adapterConfig: { workspaceStrategy: {
        type: "git_worktree", baseRef: "base", branchTemplate: "shared-template",
        worktreeParentDir: path.join(root, "custom-worktrees"),
        provisionCommand: "printf setup > setup.txt",
      } } } });
    const [foreignBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, foreignWorkspaceId));
    let dispatchedWorkspaceId: string | null = null;
    const interactionId = randomUUID();
    const providerSessionId = randomUUID();
    let firstConfig: unknown;
    execute.mockImplementationOnce(async (input) => {
      firstConfig = input.config.workspaceStrategy;
      const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
      dispatchedWorkspaceId = bound.executionWorkspaceId;
      expect(dispatchedWorkspaceId).not.toBe(foreignWorkspaceId);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, dispatchedWorkspaceId!));
      expect(workspace).toMatchObject({ sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree" });
      expect(workspace.cwd).not.toBe(parent);
      expect(workspace.metadata).toMatchObject({ workspaceReuseFallback: {
        reason: "cross_issue_workspace_not_clean", executionWorkspaceId: foreignWorkspaceId, sourceIssueId,
      } });
      expect(workspace.cwd).toContain("custom-worktrees");
      expect(await fs.readFile(path.join(workspace.cwd!, "setup.txt"), "utf8")).toBe("setup");
      expect(bound.executionWorkspaceSettings).toMatchObject({ workspaceStrategy: {
        type: "git_worktree", branchTemplate: `SAFE-2-isolated-${issueId}`,
        baseRef: "base", provisionCommand: "printf setup > setup.txt",
      } });
      await fs.writeFile(path.join(workspace.cwd!, "tracked.txt"), "child work\n");
      await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId,
        kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Continue the fixture?" } });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Safe dispatch", provider: "test", model: "test-model",
        sessionParams: { sessionId: providerSessionId }, sessionDisplayId: providerSessionId };
    });
    const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_assigned", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
    }, { timeout: 30_000, interval: 100 });
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatchedWorkspaceId).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interactionId));
    await db.update(issues).set({ status: "in_progress", unblockDescriptor: null }).where(eq(issues.id, issueId));
    execute.mockImplementationOnce(async (input) => {
      expect(input.config.workspaceStrategy).toEqual(firstConfig);
      expect(input.runtime.sessionParams?.sessionId).toBe(providerSessionId);
      const [bound] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(bound.executionWorkspaceId).toBe(dispatchedWorkspaceId);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, dispatchedWorkspaceId!));
      expect(await fs.readFile(path.join(workspace.cwd!, "tracked.txt"), "utf8")).toBe("child work\n");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Resumed safely", provider: "test", model: "test-model" };
    });
    const resumed = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_commented", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" } });
    expect(resumed).not.toBeNull();
    await vi.waitFor(async () => {
      expect((await heartbeat.getRun(resumed!.id))?.status).toBe("succeeded");
    }, { timeout: 30_000, interval: 100 });
    expect(execute).toHaveBeenCalledTimes(2);
    const [foreignAfter] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, foreignWorkspaceId));
    expect(foreignAfter).toEqual(foreignBefore);
    expect(await git(parent, "status", "--porcelain")).toBe(parentStatus);
    expect(await fs.readFile(path.join(parent, "tracked.txt"), "utf8")).toBe("foreign work\n");
  }, 90_000);
});
