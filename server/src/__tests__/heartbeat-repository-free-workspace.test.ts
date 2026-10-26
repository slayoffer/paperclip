import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, createDb, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn());
const gitExec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await gitExec("git", args, { cwd })).stdout.trim();
}
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("repository-free workspace dispatch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-repository-free-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "false");
    database = await startEmbeddedPostgresTestDatabase("repository-free-dispatch");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(authUsers).values({ id: "directory-user", name: "Fixture", email: "directory@example.test",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => {
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["report-default", "report-isolated", "manual-no-project", "code-project", "saved-session"])(
    "binds %s to its own context and preserves source files",
    async (kind) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      const sourceIssueId = randomUUID();
      const foreignWorkspaceId = randomUUID();
      const projectId = kind === "manual-no-project" ? null : randomUUID();
      const sourceProjectId = projectId ?? randomUUID();
      const prefix = `D${kind.replaceAll("-", "").toUpperCase()}`;
      await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: prefix,
        defaultResponsibleUserId: "directory-user" });
      await db.insert(projects).values({ id: sourceProjectId, companyId, name: "Source project" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer",
        status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
      const foreignCwd = projectId
        ? resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: null })
        : resolveDefaultAgentWorkspaceDir(agentId);
      await mkdir(foreignCwd, { recursive: true });
      if (kind === "code-project") {
        await git(foreignCwd, "init", "-b", "base");
        await git(foreignCwd, "config", "user.name", "Fixture");
        await git(foreignCwd, "config", "user.email", "directory@example.test");
        await writeFile(path.join(foreignCwd, "source.txt"), "Committed base\n");
        await git(foreignCwd, "add", "source.txt");
        await git(foreignCwd, "commit", "-m", "Initial fixture");
        await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId: projectId!,
          name: "Authorized repository", cwd: foreignCwd, repoRef: "base", isPrimary: true });
      }
      await writeFile(path.join(foreignCwd, "source.txt"), "Retain source work\n");
      await db.insert(issues).values({ id: sourceIssueId, companyId, projectId: sourceProjectId, title: "Source", status: "done" });
      await db.insert(executionWorkspaces).values({ id: foreignWorkspaceId, companyId, projectId: sourceProjectId,
        sourceIssueId, name: "Foreign directory", status: "active", mode: "shared_workspace",
        strategyType: "project_primary", cwd: foreignCwd, providerType: "local", providerRef: foreignCwd });
      await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Current task",
        identifier: `${prefix}-2`, status: "in_progress", assigneeAgentId: agentId,
        originKind: kind.startsWith("report") ? "routine_execution" : "manual",
        ...(kind === "report-isolated" || kind === "code-project"
          ? { executionWorkspaceSettings: { mode: "isolated_workspace" } } : {}),
      });
      if (kind === "saved-session") {
        await db.update(executionWorkspaces).set({ sourceIssueId: issueId }).where(eq(executionWorkspaces.id, foreignWorkspaceId));
        await db.insert(agentTaskSessions).values({ id: randomUUID(), companyId, agentId, adapterType: "codex_local",
          taskKey: issueId, sessionParamsJson: { sessionId: randomUUID(), cwd: foreignCwd } });
      }
      const [foreignBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, foreignWorkspaceId));
      if (!projectId) {
        const callsBefore = execute.mock.calls.length;
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
          contextSnapshot: { issueId, taskId: issueId } });
        await vi.waitFor(async () => {
          const latest = await heartbeat.getRun(run!.id);
          expect(latest?.status).toBe("failed");
          expect(latest?.resultJson).toMatchObject({ workspaceValidation: {
            reason: "cross_issue_workspace_not_clean", sourceIssueId, cleanliness: "unknown",
          } });
        }, { timeout: 30_000 });
        expect(execute.mock.calls.length).toBe(callsBefore);
        const [foreignAfter] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, foreignWorkspaceId));
        expect(foreignAfter).toEqual(foreignBefore);
        expect(await readFile(path.join(foreignCwd, "source.txt"), "utf8")).toBe("Retain source work\n");
        return;
      }
      let directory: string | null = null;
      let binding: string | null = null;
      execute.mockImplementation(async (input) => {
        const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
        const [workspace] = task.executionWorkspaceId
          ? await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId))
          : [];
        const cwd = input.context.paperclipWorkspace.cwd as string;
        if (projectId) {
          expect(workspace).toMatchObject({ sourceIssueId: issueId, companyId, projectId,
            mode: kind === "saved-session" ? "shared_workspace" : "isolated_workspace" });
          expect(cwd).toBe(workspace.cwd);
        } else if (kind === "saved-session") {
          expect(cwd).toBe(foreignCwd);
          expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("Retain source work\n");
        } else {
          expect(task.executionWorkspaceId).toBeNull();
        }
        if (kind === "code-project") {
          expect(workspace.strategyType).toBe("git_worktree");
          expect(await git(cwd, "rev-parse", "HEAD")).toBe(await git(foreignCwd, "rev-parse", "base"));
          expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("Committed base\n");
        } else {
          if (projectId) expect(workspace).toMatchObject({ strategyType: "project_primary", metadata: { isolatedTaskDirectory: true } });
          expect(cwd).toContain(`/isolated-workspaces/${companyId}/${issueId}`);
        }
        if (kind !== "saved-session") expect(cwd).not.toBe(foreignCwd);
        if (directory) {
          expect(cwd).toBe(directory);
          expect(task.executionWorkspaceId).toBe(binding);
          expect(await readFile(path.join(directory, "report.txt"), "utf8")).toBe("Task output\n");
        } else {
          directory = cwd;
          binding = task.executionWorkspaceId;
          await writeFile(path.join(directory, "report.txt"), "Task output\n");
        }
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return { exitCode: 0, signal: null, timedOut: false, summary: "Checked task directory" };
      });
      for (let turn = 0; turn < 2; turn += 1) {
        if (turn) await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
          contextSnapshot: { issueId, taskId: issueId, ...(projectId ? { projectId } : {}) } });
        expect(run).not.toBeNull();
        await vi.waitFor(async () => {
          const latest = await heartbeat.getRun(run!.id);
          expect({ status: latest?.status, error: latest?.error }).toEqual({ status: "succeeded", error: null });
        }, { timeout: 30_000 });
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
      }
      const [foreignAfter] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, foreignWorkspaceId));
      expect(foreignAfter).toEqual(foreignBefore);
      expect(await readFile(path.join(foreignCwd, "source.txt"), "utf8")).toBe("Retain source work\n");
    }, 90_000,
  );
});
