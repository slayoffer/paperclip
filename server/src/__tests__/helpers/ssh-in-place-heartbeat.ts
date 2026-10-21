import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, companies, costEvents, createDb,
  environments, heartbeatRunEvents, heartbeatRuns, issues, projects, projectWorkspaces,
  workspaceOperations } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { instanceSettingsService } from "../../services/instance-settings.js";

const execFileAsync = promisify(execFile);

export type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

export async function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

export async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-in-place-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

export async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

export async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    try {
      // Upstream run completion records cost events that reference the run.
      await db.delete(costEvents);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

export async function listFinalizeOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize"),
    ))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

export function readTarget(input: unknown) {
  const ctx = input as {
    executionTarget?: {
      kind?: string;
      transport?: string;
      remoteCwd?: string;
      spec?: { remoteCwd?: string };
      workspaceRealization?: { mode?: string; authoritativeRoot?: string; runtimeRoot?: string | null } | null;
    } | null;
    context?: Record<string, unknown>;
  };
  const workspace = (ctx.context?.paperclipWorkspace ?? {}) as Record<string, unknown>;
  return {
    target: ctx.executionTarget ?? null,
    workspaceCwd: typeof workspace.cwd === "string" ? workspace.cwd : null,
  };
}

export async function seedRunTarget(db: Db, input: { repoRoot: string; remoteBase: string }) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();
  const environmentId = randomUUID();

  await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
  });
  await db.insert(projects).values({ id: projectId, companyId, name: "SSH in_place", status: "active" });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: input.repoRoot,
    isPrimary: true,
  });
  await db.insert(environments).values({
    id: environmentId,
    companyId,
    name: `Same host ${environmentId}`,
    driver: "ssh",
    status: "active",
    config: { host: "same-host.invalid", username: "test", remoteWorkspacePath: input.remoteBase },
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    defaultEnvironmentId: environmentId,
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId,
    title: "Work in place on the shared host",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: agentId,
    identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    executionWorkspaceSettings: { mode: "isolated_workspace" },
  });
  return { companyId, issueId, agentId, environmentId };
}

export async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}
