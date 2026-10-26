import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  realizeExecutionWorkspace,
  type GitRemoteAuthProvider,
} from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
const branch = "review/pinned-branch";

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pinned-fetch-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.test");
  await fs.writeFile(path.join(source, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(source, ".gitignore"), ".paperclip/\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Initial fixture");
  await git(root, "clone", "--bare", source, remote);
  await git(root, "clone", "--single-branch", "--branch", "main", remote, checkout);
  await git(source, "checkout", "-b", branch);
  await fs.writeFile(path.join(source, "pinned.txt"), "remote work\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Remote branch fixture");
  await git(source, "push", remote, branch);
  return { root, source, remote, checkout, tip: await git(source, "rev-parse", "HEAD") };
}

function realize(checkout: string, requestedBranch = branch, resolveGitAuth?: GitRemoteAuthProvider, baseRef = "HEAD") {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: checkout,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: baseRef,
    },
    config: { workspaceStrategy: { type: "git_worktree", existingBranch: requestedBranch } },
    issue: { id: "issue-1", identifier: "TEST-1", title: "Fetch pinned branch" },
    agent: { id: "agent-1", companyId: "company-1", name: "Fixture" },
    resolveGitAuth,
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("pinned existing branch fetch", () => {
  it("fetches a remote-only branch and realizes its exact tip without changing source edits", async () => {
    const f = await fixture();
    expect(await git(f.checkout, "branch", "--list", branch)).toBe("");
    await expect(git(f.checkout, "rev-parse", "--verify", `refs/remotes/origin/${branch}`)).rejects.toThrow();
    const head = await git(f.checkout, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.checkout, "tracked.txt"), "unfinished source work\n");
    await fs.writeFile(path.join(f.checkout, "untracked.txt"), "untracked source work\n");
    const status = await git(f.checkout, "status", "--porcelain");
    const auth = vi.fn(async () => ({
      configArgs: ["-c", "protocol.file.allow=always"],
      env: { GIT_TERMINAL_PROMPT: "0" },
    }));

    const workspace = await realize(f.checkout, branch, auth, `origin/${branch}`);

    expect(auth).toHaveBeenCalledWith(f.remote);
    expect(workspace).toMatchObject({
      branchName: branch,
      strategy: "git_worktree",
      created: true,
      branchCreatedByRuntime: false,
      baseRefSha: f.tip,
    });
    expect(workspace.cwd).not.toBe(f.checkout);
    expect(await git(workspace.cwd, "branch", "--show-current")).toBe(branch);
    expect(await git(workspace.cwd, "rev-parse", "HEAD")).toBe(f.tip);
    expect(await git(f.checkout, "rev-parse", `refs/heads/${branch}`)).toBe(f.tip);
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(head);
    expect(await git(f.checkout, "status", "--porcelain")).toBe(status);
    expect(await fs.readFile(path.join(f.checkout, "tracked.txt"), "utf8")).toBe("unfinished source work\n");
    expect(await fs.readFile(path.join(f.checkout, "untracked.txt"), "utf8")).toBe("untracked source work\n");
  });

  it("names the missing local and remote refs when the branch is absent on origin", async () => {
    const f = await fixture();
    const missingBranch = "review/absent";
    const head = await git(f.checkout, "rev-parse", "HEAD");
    const auth = vi.fn(async () => null);

    await expect(realize(f.checkout, missingBranch, auth)).rejects.toMatchObject({
      code: "workspace_validation_failed",
      message: expect.stringContaining(`refs/remotes/origin/${missingBranch}`),
      resultJson: {
        workspaceValidation: {
          reason: "existing_branch_not_found",
          requestedExistingBranch: missingBranch,
          localRef: `refs/heads/${missingBranch}`,
          remoteRef: `refs/remotes/origin/${missingBranch}`,
          fetchError: expect.stringContaining("couldn't find remote ref"),
        },
      },
    });
    expect(auth).toHaveBeenCalledWith(f.remote);
    expect(await git(f.checkout, "branch", "--list", missingBranch)).toBe("");
    expect(await git(f.checkout, "rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(f.checkout, ".paperclip", "worktrees"))).rejects.toThrow();
  });

  it("refuses a deleted remote branch even if a stale tracking ref exists", async () => {
    const f = await fixture();
    await git(f.checkout, "fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
    await git(f.source, "push", f.remote, "--delete", branch);

    await expect(realize(f.checkout)).rejects.toMatchObject({ code: "workspace_validation_failed" });

    expect(await git(f.checkout, "branch", "--list", branch)).toBe("");
  });

  it("uses the supplied fetch configuration and environment without persisting them", async () => {
    const f = await fixture();
    const configPath = path.join(f.root, "git-config");
    await fs.writeFile(configPath, "[protocol \"file\"]\n\tallow = never\n");
    const auth = vi.fn(async () => ({
      configArgs: ["-c", "protocol.file.allow=always"],
      env: { GIT_CONFIG_GLOBAL: configPath, GIT_TERMINAL_PROMPT: "0" },
    }));

    const workspace = await realize(f.checkout, branch, auth);

    expect(await git(workspace.cwd, "rev-parse", "HEAD")).toBe(f.tip);
    expect(await fs.readFile(path.join(f.checkout, ".git", "config"), "utf8")).not.toContain("protocol.file");
    expect(await fs.readFile(path.join(f.checkout, ".git", "config"), "utf8")).not.toContain(configPath);
  });

  it("refuses a failed authorized fetch instead of using a stale ref or ambient access", async () => {
    const f = await fixture();
    await git(f.checkout, "fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const auth = vi.fn(async () => ({
      configArgs: ["-c", "protocol.file.allow=never"],
      env: { GIT_TERMINAL_PROMPT: "0" },
    }));

    await expect(realize(f.checkout, branch, auth)).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: { workspaceValidation: { fetchError: expect.stringContaining("transport 'file' not allowed") } },
    });
    expect(auth).toHaveBeenCalledOnce();
    expect(await git(f.checkout, "branch", "--list", branch)).toBe("");
  });

  it("preserves an existing local branch and its dirty registered worktree", async () => {
    const f = await fixture();
    await git(f.checkout, "branch", branch, "HEAD");
    const localTip = await git(f.checkout, "rev-parse", branch);
    const registered = path.join(f.root, "registered");
    await git(f.checkout, "worktree", "add", registered, branch);
    await fs.writeFile(path.join(registered, "tracked.txt"), "existing branch edits\n");
    const auth = vi.fn(async () => null);

    const workspace = await realize(f.checkout, branch, auth, localTip);

    expect(workspace).toMatchObject({ cwd: registered, created: false, branchCreatedByRuntime: false });
    expect(auth).not.toHaveBeenCalled();
    expect(await git(registered, "rev-parse", "HEAD")).toBe(localTip);
    expect(await fs.readFile(path.join(registered, "tracked.txt"), "utf8")).toBe("existing branch edits\n");
  });
});
