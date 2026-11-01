import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { logger } from "../middleware/logger.js";

describe("issue terminal workspace cleanup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-terminal-close-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
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
  const readWorkspace = (id: string) => db.select().from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, id)).then(([row]) => row);

  it.each(["done", "cancelled"])("closes every owned git worktree after %s commits", async (status) => {
    const f = await fixture();
    const first = await f.workspace();
    const second = await f.workspace();
    await db.update(issues).set({ executionWorkspaceId: first.id }).where(eq(issues.id, f.issue.id));
    const result = await issueService(db).update(f.issue.id, { status });
    expect(result?.status).toBe(status);
    for (const row of [first, second]) {
      expect(await readWorkspace(row.id)).toMatchObject({ status: "archived", metadata: { lifecycleGeneration: 1 } });
      expect(existsSync(row.cwd!)).toBe(false);
    }
  });

  it.each(["dirty", "untracked", "unpushed", "unpushed merged", "runtime", "open link", "active run"])("keeps %s workspaces active and logs the reason", async (blocker) => {
    const f = await fixture();
    const row = await f.workspace();
    if (blocker === "dirty") await writeFile(join(row.cwd!, "tracked"), "changed\n");
    if (blocker === "untracked") await writeFile(join(row.cwd!, "new"), "new\n");
    if (blocker.startsWith("unpushed")) {
      await writeFile(join(row.cwd!, "tracked"), "commit\n");
      git(row.cwd!, "commit", "-am", "unpublished");
      if (blocker === "unpushed merged") git(f.repo, "merge", row.branchName!);
    }
    if (blocker === "runtime") await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(), companyId: f.company.id, executionWorkspaceId: row.id,
      scopeType: "execution_workspace", serviceName: "preview", status: "running", lifecycle: "persistent", provider: "process",
    });
    if (blocker === "open link") await db.insert(issues).values({
      companyId: f.company.id, title: "Still working", status: "todo", executionWorkspaceId: row.id,
    });
    if (blocker === "active run") {
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Worker" }).returning();
      await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, issueId: f.issue.id, status: "running" });
    }
    const log = vi.spyOn(logger, "warn");
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: row.id, reasons: expect.any(Array) }), expect.any(String));
  });

  it.each([
    { mode: "shared_workspace" }, { strategyType: "project_primary" }, { providerType: "local_fs" },
  ])("never closes protected workspace %j", async (patch) => {
    const f = await fixture();
    const row = await f.workspace(patch);
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it.each(["source", "linked"])("keeps a cwd used by another open issue through its %s workspace", async (association) => {
    const f = await fixture();
    const row = await f.workspace();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Open owner", status: "todo" }).returning();
    const alias = await f.workspace({ cwd: row.cwd, providerRef: row.cwd,
      sourceIssueId: association === "source" ? other.id : null });
    if (association === "linked") await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, other.id));
    await issueService(db).update(f.issue.id, { status: "cancelled" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it("waits for the caller transaction to commit", async () => {
    const f = await fixture();
    const row = await f.workspace();
    const actions: IssuePostCommitAction[] = [];
    await db.transaction(async (tx) => {
      await issueService(db).update(f.issue.id, { status: "done" }, tx, undefined, actions);
      expect((await readWorkspace(row.id)).status).toBe("active");
      expect(existsSync(row.cwd!)).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("in_progress");
    });
    await executeIssuePostCommitActions(db, actions);
    expect((await readWorkspace(row.id)).status).toBe("archived");
    expect(existsSync(row.cwd!)).toBe(false);
  });

  it("does no cleanup after rollback", async () => {
    const f = await fixture();
    const row = await f.workspace();
    const actions: IssuePostCommitAction[] = [];
    await expect(db.transaction(async (tx) => {
      await issueService(db).update(f.issue.id, { status: "done" }, tx, undefined, actions);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it("reopens a removed worktree through the existing reopen service", async () => {
    const f = await fixture();
    const row = await f.workspace();
    await db.update(issues).set({ executionWorkspaceId: row.id }).where(eq(issues.id, f.issue.id));
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(existsSync(row.cwd!)).toBe(false);
    const result = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId: row.id, issue: f.issue, actor: { actorType: "user", agentId: null },
    });
    expect(result.ok).toBe(true);
    await issueService(db).update(f.issue.id, { status: "todo" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(await readFile(join(row.cwd!, "tracked"), "utf8")).toBe("initial\n");
    expect(git(row.cwd!, "status", "--porcelain")).toBe("");
  });

  it("logs cleanup failure, preserves the committed status, and continues to the next workspace", async () => {
    const f = await fixture();
    const locked = await f.workspace();
    const next = await f.workspace();
    git(f.repo, "worktree", "lock", locked.cwd!);
    const log = vi.spyOn(logger, "warn");
    expect((await issueService(db).update(f.issue.id, { status: "done" }))?.status).toBe("done");
    expect((await readWorkspace(locked.id)).status).toBe("cleanup_failed");
    expect((await readWorkspace(next.id)).status).toBe("archived");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: locked.id }), expect.any(String));
  });

  it("serializes cleanup across simultaneous issue updates", async () => {
    vi.stubEnv("SHELL", "/bin/sh");
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other", status: "in_progress" }).returning();
    const trace = join(f.root, "order");
    const metadata = { config: { cleanupCommand: `echo start >> '${trace}'; sleep 0.2; echo end >> '${trace}'` } };
    await f.workspace({ metadata });
    await f.workspace({ sourceIssueId: other.id, metadata });
    await Promise.all([f.issue, other].map((issue) => issueService(db).update(issue.id, { status: "done" })));
    expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual(["start", "end", "start", "end"]);
  });

  it("keeps the primary checkout even when a legacy row declares an isolated worktree", async () => {
    const f = await fixture();
    const row = await f.workspace({ cwd: f.repo, providerRef: f.repo });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(f.repo)).toBe(true);
  });

  it("closes a linked workspace with no source issue", async () => {
    const f = await fixture();
    const row = await f.workspace({ sourceIssueId: null });
    await db.update(issues).set({ executionWorkspaceId: row.id }).where(eq(issues.id, f.issue.id));
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("archived");
  });

  it("ignores an archived cwd alias of an open issue", async () => {
    const f = await fixture();
    const row = await f.workspace();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Open", status: "todo" }).returning();
    await f.workspace({ cwd: row.cwd, providerRef: row.cwd, sourceIssueId: other.id, status: "archived" });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("archived");
  });

  it("skips a stale post-commit action after the issue reopens", async () => {
    const f = await fixture();
    const row = await f.workspace();
    const actions: IssuePostCommitAction[] = [];
    await issueService(db).update(f.issue.id, { status: "done" }, db, undefined, actions);
    await issueService(db).update(f.issue.id, { status: "todo" });
    await executeIssuePostCommitActions(db, actions);
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it("keeps a workspace during the reopen consumption window", async () => {
    const f = await fixture();
    const row = await f.workspace({ metadata: { reopenPendingConsumption: true, lifecycleGeneration: 4 } });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it("closes a clean pushed branch before it is merged", async () => {
    const f = await fixture();
    const row = await f.workspace();
    await writeFile(join(row.cwd!, "tracked"), "published\n");
    git(row.cwd!, "commit", "-am", "published");
    git(row.cwd!, "push", "-u", "origin", row.branchName!);
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("archived");
    expect(existsSync(row.cwd!)).toBe(false);
  });

  it.each(["todo", "done"])("does not close workspaces on an unchanged %s status", async (status) => {
    const f = await fixture();
    const row = await f.workspace();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issue.id));
    await issueService(db).update(f.issue.id, { status, title: "Edited" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });
});
