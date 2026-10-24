import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, executionWorkspaces, issues, projects } from "@paperclipai/db";
import { ensurePersistedExecutionWorkspaceAvailable, realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { resolveUnsafeWorkspaceReuseFallback } from "../services/workspace-reuse-fallback.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const exec = promisify(execFile);
const roots: string[] = [];
const sourceIssueId = randomUUID();
const childIssueId = randomUUID();
const companyId = randomUUID();
const projectId = randomUUID();
const issue = { id: childIssueId, identifier: "TEST-2", title: "Child" };
const agent = { id: null, name: "Fixture", companyId };

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-safety-"));
  roots.push(root);
  await git(root, "init", "-b", "base");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "Initial fixture");
  const base = { baseCwd: root, source: "project_primary" as const,
    projectId, workspaceId: null, repoUrl: null, repoRef: "base" };
  const workspace = { sourceIssueId, mode: "shared_workspace", strategyType: "project_primary",
    cwd: root, providerRef: root, projectId, projectWorkspaceId: null,
    repoUrl: null, baseRef: "base", branchName: "base" };
  return { root, base, workspace };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("persisted cross-issue workspace reuse", () => {
  it("permits explicit sharing of a clean workspace", async () => {
    const f = await fixture();
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...f, issue, agent }))
      .resolves.toMatchObject({ cwd: f.root });
  });

  it.each(["staged", "unstaged", "untracked"])("rejects foreign %s changes without changing files", async (kind) => {
    const f = await fixture();
    if (kind === "untracked") {
      await fs.writeFile(path.join(f.root, "untracked.txt"), "parent work\n");
      await git(f.root, "config", "status.showUntrackedFiles", "no");
    } else {
      await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
      if (kind === "staged") await git(f.root, "add", "tracked.txt");
    }
    const before = await git(f.root, "status", "--porcelain", "--untracked-files=all");
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...f, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { reason: "cross_issue_workspace_not_clean", cleanliness: "dirty", sourceIssueId },
      } });
    expect(await git(f.root, "status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(await git(f.root, "diff", "--cached")).toContain(kind === "staged" ? "parent work" : "");
  });

  it("permits the source issue to resume its own dirty workspace", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...f, issue: { ...issue, id: sourceIssueId }, agent }))
      .resolves.toMatchObject({ cwd: f.root });
  });

  it("refuses foreign reuse when Git status cannot be read", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.root, ".git"), { recursive: true });
    await expect(ensurePersistedExecutionWorkspaceAvailable({ ...f, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { cleanliness: "unknown" },
      } });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("worktree selection by branch", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reuse-safety-db-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Fixture", issuePrefix: "SAFE" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fixture" });
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Source", projectId });
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  it.each(["closed", "archived"])("ignores %s foreign workspace records", async (status) => {
    const f = await fixture();
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Old workspace",
      cwd: f.root, providerRef: f.root, status });
    await fs.writeFile(path.join(f.root, "tracked.txt"), "unfinished work\n");
    await expect(realizeExecutionWorkspace({ db, base: f.base, config: {}, issue, agent }))
      .resolves.toMatchObject({ cwd: f.root });
    expect(await fs.readFile(path.join(f.root, "tracked.txt"), "utf8")).toBe("unfinished work\n");
  });

  it("does not let an archived owner bypass an active foreign workspace", async () => {
    const f = await fixture();
    await db.insert(issues).values({ id: childIssueId, companyId, projectId, title: "Child" });
    await db.insert(executionWorkspaces).values([
      { companyId, projectId, sourceIssueId: childIssueId, status: "archived",
        mode: "shared_workspace", strategyType: "project_primary", name: "Old owner", cwd: f.root },
      { companyId, projectId, sourceIssueId, status: "active",
        mode: "shared_workspace", strategyType: "project_primary", name: "Current owner", cwd: f.root },
    ]);
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    await expect(realizeExecutionWorkspace({ db, base: f.base, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed" });
  });

  it.each(["closed", "archived"])("ignores a direct %s binding but protects active owners", async (status) => {
    const f = await fixture();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Historical binding",
      cwd: f.root, status }).returning();
    await fs.writeFile(path.join(f.root, "tracked.txt"), "unfinished work\n");
    await expect(ensurePersistedExecutionWorkspaceAvailable({ db, ...f, workspace, issue, agent }))
      .resolves.toMatchObject({ cwd: f.root });
    await expect(resolveUnsafeWorkspaceReuseFallback({ db, companyId, issueId: childIssueId, workspace }))
      .resolves.toBeNull();
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Active owner", cwd: f.root });
    await expect(ensurePersistedExecutionWorkspaceAvailable({ db, ...f, workspace, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed" });
    await expect(resolveUnsafeWorkspaceReuseFallback({ db, companyId, issueId: childIssueId, workspace }))
      .resolves.toMatchObject({ reason: "cross_issue_workspace_not_clean" });
  });

  it("permits a project-less home outside Git despite an active foreign record", async () => {
    const root = await fs.mkdtemp(path.join(os.homedir(), ".paperclip-reuse-home-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "notes.txt"), "home notes\n");
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Legacy home", cwd: root });
    const base = { baseCwd: root, source: "agent_home" as const, projectId: null,
      workspaceId: null, repoUrl: null, repoRef: null };
    await expect(realizeExecutionWorkspace({ db, base, config: {}, issue, agent }))
      .resolves.toMatchObject({ cwd: root, source: "agent_home", projectId: null });
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("home notes\n");
    await expect(realizeExecutionWorkspace({ db, base: { ...base, projectId }, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed" });
    await fs.mkdir(path.join(root, ".git"));
    await expect(realizeExecutionWorkspace({ db, base, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { cleanliness: "unknown" },
      } });
  });

  it("still protects foreign changes when a project-less home is a Git repository", async () => {
    const f = await fixture();
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Home repository", cwd: f.root });
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    await expect(realizeExecutionWorkspace({ db,
      base: { ...f.base, source: "agent_home", projectId: null }, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { cleanliness: "dirty" },
      } });
  });

  it("creates the child from its base ref and preserves the dirty parent", async () => {
    const f = await fixture();
    const baseSha = await git(f.root, "rev-parse", "base");
    const parent = path.join(f.root, "parent");
    await git(f.root, "worktree", "add", "-b", "parent", parent);
    await fs.writeFile(path.join(parent, "parent-only.txt"), "parent commit\n");
    await git(parent, "add", "parent-only.txt");
    await git(parent, "commit", "-m", "Parent work");
    await fs.writeFile(path.join(parent, "tracked.txt"), "unfinished parent work\n");
    await git(parent, "add", "tracked.txt");
    const parentStatus = await git(parent, "status", "--porcelain");
    const child = await realizeExecutionWorkspace({ db, base: f.base, issue, agent,
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "base", branchTemplate: "review/{{issue.identifier}}" } },
    });
    expect(child.cwd).not.toBe(parent);
    expect(child.branchName).toBe("review/TEST-2");
    expect(await git(child.cwd, "rev-parse", "HEAD")).toBe(baseSha);
    await expect(fs.access(path.join(child.cwd, "parent-only.txt"))).rejects.toThrow();
    expect(await git(parent, "status", "--porcelain")).toBe(parentStatus);
    expect(await fs.readFile(path.join(parent, "tracked.txt"), "utf8")).toBe("unfinished parent work\n");
  });

  it("refuses a dirty foreign worktree selected without a persisted binding", async () => {
    const f = await fixture();
    const worktree = path.join(f.root, "parent");
    await git(f.root, "worktree", "add", "-b", "parent", worktree);
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Parent", cwd: worktree, branchName: "parent" });
    await fs.writeFile(path.join(worktree, "tracked.txt"), "parent work\n");
    const config = { workspaceStrategy: { type: "git_worktree", existingBranch: "parent", baseRef: "base", provisionCommand: "touch provisioned" } };
    await expect(realizeExecutionWorkspace({ db, base: f.base, config, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { reason: "cross_issue_workspace_not_clean", sourceIssueId },
      } });
    await expect(fs.access(path.join(worktree, "provisioned"))).rejects.toThrow();
    expect(await fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).toBe("parent work\n");
    await git(worktree, "checkout", "--", "tracked.txt");
    await expect(realizeExecutionWorkspace({ db, base: f.base, config, issue, agent }))
      .resolves.toMatchObject({ cwd: worktree, branchName: "parent" });
  });

  it.each(["cwd", "providerRef"] as const)("protects a dirty branch when its saved %s is a symbolic link", async (field) => {
    const f = await fixture();
    const worktree = path.join(f.root, "parent");
    await git(f.root, "worktree", "add", "-b", "parent", worktree);
    const alias = path.join(f.root, "parent-alias");
    await fs.symlink(worktree, alias, "dir");
    await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Parent alias",
      [field]: alias, branchName: "parent" });
    await fs.writeFile(path.join(worktree, "tracked.txt"), "parent work\n");
    const before = await git(worktree, "status", "--porcelain");
    const config = { workspaceStrategy: { type: "git_worktree", existingBranch: "parent",
      baseRef: "base", provisionCommand: "touch provisioned" } };
    await expect(realizeExecutionWorkspace({ db, base: f.base, config, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { reason: "cross_issue_workspace_not_clean", sourceIssueId },
      } });
    await expect(fs.access(path.join(worktree, "provisioned"))).rejects.toThrow();
    expect(await git(worktree, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).toBe("parent work\n");
    await expect(realizeExecutionWorkspace({ db, base: f.base,
      config: { workspaceStrategy: { ...config.workspaceStrategy, provisionCommand: "true" } },
      issue: { ...issue, id: sourceIssueId }, agent,
    })).resolves.toMatchObject({ cwd: worktree, branchName: "parent" });
    await git(worktree, "checkout", "--", "tracked.txt");
    await expect(realizeExecutionWorkspace({ db, base: f.base, config, issue, agent }))
      .resolves.toMatchObject({ cwd: worktree, branchName: "parent" });
  });

  it("protects a legacy binding when the candidate path is a symbolic link", async () => {
    const f = await fixture();
    const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-alias-"));
    roots.push(aliasRoot);
    const alias = path.join(aliasRoot, "checkout");
    await fs.symlink(f.root, alias, "dir");
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Legacy alias", cwd: f.root,
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, sourceIssueId));
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    const base = { ...f.base, baseCwd: alias };
    await expect(realizeExecutionWorkspace({ db, base, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { sourceIssueId, cleanliness: "dirty" },
      } });
    await expect(ensurePersistedExecutionWorkspaceAvailable({ db, base,
      workspace: { ...f.workspace, cwd: alias, providerRef: alias, sourceIssueId: null }, issue, agent,
    })).rejects.toMatchObject({ code: "workspace_validation_failed" });
    await expect(realizeExecutionWorkspace({ db, base, config: {},
      issue: { ...issue, id: sourceIssueId }, agent,
    })).resolves.toMatchObject({ cwd: alias });
  });

  it("keeps canonical owner selection inside the company", async () => {
    const f = await fixture();
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: "OTHER" });
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "Other" });
    await db.insert(issues).values({ id: otherIssueId, companyId: otherCompanyId, title: "Other" });
    const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-company-"));
    roots.push(aliasRoot);
    const alias = path.join(aliasRoot, "checkout");
    await fs.symlink(f.root, alias, "dir");
    await db.insert(executionWorkspaces).values({ companyId: otherCompanyId, projectId: otherProjectId,
      sourceIssueId: otherIssueId, mode: "shared_workspace", strategyType: "project_primary",
      name: "Other company alias", cwd: alias });
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    await expect(realizeExecutionWorkspace({ db, base: f.base, config: {}, issue, agent }))
      .resolves.toMatchObject({ cwd: f.root });
  });

  it("protects a legacy workspace through the other issue's binding", async () => {
    const f = await fixture();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId,
      mode: "shared_workspace", strategyType: "project_primary", name: "Legacy", cwd: f.root,
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, sourceIssueId));
    await fs.writeFile(path.join(f.root, "tracked.txt"), "parent work\n");
    await expect(ensurePersistedExecutionWorkspaceAvailable({ db, ...f,
      workspace: { ...f.workspace, sourceIssueId: null }, issue, agent,
    })).rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
      workspaceValidation: { sourceIssueId, cleanliness: "dirty" },
    } });
    await expect(realizeExecutionWorkspace({ db, base: f.base, config: {}, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed", resultJson: {
        workspaceValidation: { sourceIssueId, cleanliness: "dirty" },
      } });
  });
});
