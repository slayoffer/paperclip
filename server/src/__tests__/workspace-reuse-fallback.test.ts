import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedWorkspaceReuseConfig, resolveUnsafeWorkspaceReuseFallback, requestedWorkspaceReuseBranch, shouldKeepWorkspaceReuseIsolation } from "../services/workspace-reuse-fallback.js";
import { ensurePersistedExecutionWorkspaceAvailable, realizeExecutionWorkspace } from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
const sourceIssueId = randomUUID();
const issueId = randomUUID();
const companyId = randomUUID();
const issue = { id: issueId, identifier: "TEST-2", title: "Child" };
const agent = { id: null, name: "Fixture", companyId };

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-reuse-fallback-"));
  roots.push(root);
  await git(root, "init", "-b", "base");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.test");
  await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "Initial fixture");
  const parent = path.join(root, "parent");
  await git(root, "worktree", "add", "-b", "parent", parent);
  const workspace = { id: randomUUID(), sourceIssueId, mode: "isolated_workspace", strategyType: "git_worktree",
    cwd: parent, providerRef: parent, projectId: null, projectWorkspaceId: null,
    repoUrl: null, baseRef: "base", branchName: "parent" };
  return { root, parent, workspace, base: { baseCwd: root, source: "project_primary" as const,
    projectId: null, workspaceId: null, repoUrl: null, repoRef: "base" } };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("unsafe inherited workspace fallback", () => {
  it.each(["staged", "unstaged", "untracked"])("isolates foreign %s changes and resumes the new workspace", async (kind) => {
    const f = await fixture();
    const file = kind === "untracked" ? "untracked.txt" : "tracked.txt";
    await fs.writeFile(path.join(f.parent, file), "parent work\n");
    if (kind === "staged") await git(f.parent, "add", file);
    const before = await git(f.parent, "status", "--porcelain", "--untracked-files=all");
    const fallback = await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace });
    expect(fallback).toMatchObject({ reason: "cross_issue_workspace_not_clean", cleanliness: "dirty", sourceIssueId });
    expect(fallback?.warning).toContain(f.workspace.id);
    const config = isolatedWorkspaceReuseConfig({
      config: { workspaceStrategy: { type: "project_primary", branchTemplate: "shared", baseRef: "base" } },
      issueId, issueIdentifier: issue.identifier,
    });
    const child = await realizeExecutionWorkspace({ base: f.base, config, issue, agent });
    expect(child.cwd).not.toBe(f.parent);
    expect(child.branchName).toBe(`TEST-2-isolated-${issueId}`);
    expect(await git(child.cwd, "rev-parse", "HEAD")).toBe(await git(f.root, "rev-parse", "base"));
    expect(await fs.readFile(path.join(child.cwd, "tracked.txt"), "utf8")).toBe("original\n");
    await expect(fs.access(path.join(child.cwd, "untracked.txt"))).rejects.toThrow();
    expect(await git(f.parent, "status", "--porcelain", "--untracked-files=all")).toBe(before);
    expect(await fs.readFile(path.join(f.parent, file), "utf8")).toBe("parent work\n");

    // Model the new task binding. Later wakes can resume the task's own dirty files.
    const ownWorkspace = { ...f.workspace, id: randomUUID(), sourceIssueId: issueId,
      cwd: child.cwd, providerRef: child.cwd, branchName: child.branchName };
    await fs.writeFile(path.join(child.cwd, "tracked.txt"), "child work\n");
    for (let wake = 0; wake < 2; wake += 1) {
      expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: ownWorkspace })).toBeNull();
      await expect(ensurePersistedExecutionWorkspaceAvailable({ base: f.base, workspace: ownWorkspace, issue, agent }))
        .resolves.toMatchObject({ cwd: child.cwd });
    }
    expect(await git(f.parent, "status", "--porcelain", "--untracked-files=all")).toBe(before);
  });

  it("keeps clean explicit sharing", async () => {
    const f = await fixture();
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace })).toBeNull();
    await expect(ensurePersistedExecutionWorkspaceAvailable({ base: f.base, workspace: f.workspace, issue, agent }))
      .resolves.toMatchObject({ cwd: f.parent });
  });

  it.each(["recovery", "existing_branch"])("keeps %s bound to its exact workspace", async (kind) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.parent, "tracked.txt"), "parent work\n");
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace,
      ...(kind === "recovery" ? { recoveryExecutionWorkspaceId: f.workspace.id } : { requestedExistingBranch: "parent" }),
    })).toBeNull();
    await expect(ensurePersistedExecutionWorkspaceAvailable({ base: f.base, workspace: f.workspace, issue, agent }))
      .rejects.toMatchObject({ code: "workspace_validation_failed" });
  });

  it("keeps missing directories on the existing restore path", async () => {
    const f = await fixture();
    await fs.rm(f.parent, { recursive: true });
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace })).toBeNull();
  });

  it("uses isolation when foreign Git status cannot be established", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.root, ".git"), { recursive: true });
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace }))
      .toMatchObject({ reason: "cross_issue_workspace_not_clean", cleanliness: "unknown" });
  });

  it.each([0, 1, 2, 3])("recognizes branch pins from strategy source %s", async (index) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.parent, "tracked.txt"), "foreign work\n");
    const strategies: unknown[] = [null, null, null, null];
    strategies[index] = { existingBranch: "parent" };
    const branch = requestedWorkspaceReuseBranch(strategies);
    expect(branch).toBe("parent");
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace,
      requestedExistingBranch: branch })).toBeNull();
  });

  it("preserves an operator branch and stops isolation when an explicit branch is selected", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.parent, "tracked.txt"), "foreign work\n");
    expect(await resolveUnsafeWorkspaceReuseFallback({ companyId, issueId, workspace: f.workspace, operatorBranch: true })).toBeNull();
    const workspace = { sourceIssueId: issueId, metadata: { workspaceReuseFallback: { reason: "cross_issue_workspace_not_clean" } } };
    expect(shouldKeepWorkspaceReuseIsolation({ issueId, workspace })).toBe(true);
    expect(shouldKeepWorkspaceReuseIsolation({ issueId, workspace, requestedExistingBranch: "chosen" })).toBe(false);
    expect(shouldKeepWorkspaceReuseIsolation({ issueId, workspace: { ...workspace, sourceIssueId } })).toBe(false);
  });

  it("refuses another company's workspace before a Git check", async () => {
    const f = await fixture();
    await expect(resolveUnsafeWorkspaceReuseFallback({ companyId, issueId,
      workspace: { ...f.workspace, companyId: randomUUID() } })).rejects.toThrow("another company");
  });

  it("removes an inherited branch pin without changing the configured hooks", () => {
    const strategy = { type: "git_worktree", existingBranch: "parent", branchTemplate: "shared",
      baseRef: "base", provisionCommand: "prepare-workspace" };
    const config = isolatedWorkspaceReuseConfig({ config: { workspaceStrategy: strategy }, issueId });
    expect(config.workspaceStrategy).toMatchObject({ type: "git_worktree", baseRef: "base", provisionCommand: "prepare-workspace" });
    expect(config.workspaceStrategy).not.toHaveProperty("existingBranch");
    expect(strategy.existingBranch).toBe("parent");
  });
});
