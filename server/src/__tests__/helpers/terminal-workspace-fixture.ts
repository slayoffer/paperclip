import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations,
  projects, projectWorkspaces, type Db } from "@paperclipai/db";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function addReleasedNativeController(db: Db, companyId: string, issueId: string) {
  const [agent] = await db.insert(agents).values({ companyId, name: "Completed worker" }).returning();
  const [run] = await db.insert(heartbeatRuns).values({
    companyId, agentId: agent.id, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded",
  }).returning();
  await db.insert(nativeRunFinalizations).values({
    runId: run.id, companyId, issueId, phase: "committed", controllerPid: process.pid,
    leaseOwner: null, leaseExpiresAt: null,
  });
}

export async function terminalWorkspaceFixture(db: Db, directories: string[]) {
  const root = await mkdtemp(join(tmpdir(), "terminal-workspace-"));
  directories.push(root);
  const repo = join(root, "repo");
  git(root, "init", "-b", "main", repo);
  // These disposable repositories must not run the host's installed Git hooks.
  git(repo, "config", "core.hooksPath", "/dev/null");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.test");
  await writeFile(join(repo, "tracked"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const remote = join(root, "remote.git");
  git(root, "clone", "--bare", repo, remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "fetch", "origin");
  const [company] = await db.insert(companies).values({ name: "Terminal close", issuePrefix: randomUUID() }).returning();
  const [project] = await db.insert(projects).values({ companyId: company.id, name: "Close test" }).returning();
  const [primary] = await db.insert(projectWorkspaces).values({
    companyId: company.id, projectId: project.id, name: "Primary", cwd: repo, isPrimary: true,
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId: company.id, projectId: project.id, title: "Close workspaces", status: "in_progress",
  }).returning();
  async function workspace(patch: Partial<typeof executionWorkspaces.$inferInsert> = {}) {
    const branch = `task-${randomUUID()}`;
    const cwd = join(root, branch);
    git(repo, "worktree", "add", "-b", branch, cwd, "main");
    const [row] = await db.insert(executionWorkspaces).values({
      companyId: company.id, projectId: project.id, projectWorkspaceId: primary.id,
      sourceIssueId: issue.id, name: branch, mode: "isolated_workspace", strategyType: "git_worktree",
      providerType: "git_worktree", cwd, providerRef: cwd, baseRef: "main", branchName: branch,
      ...patch,
    }).returning();
    return row;
  }
  return { root, repo, company, project, primary, issue, workspace };
}
