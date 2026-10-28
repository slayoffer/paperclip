import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionExecutionWorkspaceForFreshnessDecision } from "../services/heartbeat/workspaces.js";
import { assertWorkspaceReuseIsSafe } from "../services/workspace-reuse-safety.js";

const gitExec = promisify(execFile);
const freshness = { action: "keep", shouldRefreshConfigSnapshot: false } as never;

// The inherited workspace belongs to the parent issue. The real reuse guard runs
// against a real Git checkout, so the failure shape is the production one.
describe("run selects a separate workspace when the inherited one is another issue's and dirty", () => {
  let root: string;
  let dirty: string;
  let clean: string;

  async function init(dir: string) {
    await fs.mkdir(dir, { recursive: true });
    await gitExec("git", ["init", "-b", "main"], { cwd: dir });
    await gitExec("git", ["config", "user.email", "fixture@example.test"], { cwd: dir });
    await gitExec("git", ["config", "user.name", "Fixture"], { cwd: dir });
    await fs.writeFile(path.join(dir, "a.txt"), "a\n");
    await gitExec("git", ["add", "a.txt"], { cwd: dir });
    await gitExec("git", ["commit", "-m", "init"], { cwd: dir });
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolation-fallback-"));
    dirty = path.join(root, "dirty");
    clean = path.join(root, "clean");
    await init(dirty);
    await init(clean);
    await fs.writeFile(path.join(dirty, "a.txt"), "parent work\n");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function guard(cwd: string) {
    return () => assertWorkspaceReuseIsSafe({
      companyId: "company-1", issueId: "child", sourceIssueId: "parent", cwd,
    }).then(() => ({ id: "inherited", warnings: [] as string[] }));
  }

  it("realizes a new isolated workspace and adds one warning", async () => {
    const realizeIsolatedWorkspace = vi.fn(async () => ({ id: "isolated", warnings: [] as string[] }));
    const result = await provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: false,
      issueRef: { id: "child", identifier: "SYNA-3182" },
      runId: "run-1",
      workspaceConfigFreshness: freshness,
      realizeWorkspace: guard(dirty),
      realizeIsolatedWorkspace,
    });
    expect(realizeIsolatedWorkspace).toHaveBeenCalledTimes(1);
    expect(result.executionWorkspace.id).toBe("isolated");
    expect(result.executionWorkspace.warnings).toHaveLength(1);
    expect(result.executionWorkspace.warnings[0]).toMatch(/belongs to another issue and is not clean/);
  });

  it("keeps the inherited workspace when it is clean", async () => {
    const realizeIsolatedWorkspace = vi.fn(async () => ({ id: "isolated", warnings: [] as string[] }));
    const result = await provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: false,
      issueRef: { id: "child", identifier: "SYNA-3182" },
      runId: "run-1",
      workspaceConfigFreshness: freshness,
      realizeWorkspace: guard(clean),
      realizeIsolatedWorkspace,
    });
    expect(result.executionWorkspace.id).toBe("inherited");
    expect(realizeIsolatedWorkspace).not.toHaveBeenCalled();
  });

  it("still fails when no isolated realization is offered, and for other errors", async () => {
    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: false,
      issueRef: { id: "child" },
      runId: "run-1",
      workspaceConfigFreshness: freshness,
      realizeWorkspace: guard(dirty),
    })).rejects.toThrow(/Cannot reuse another issue's workspace/);
    const realizeIsolatedWorkspace = vi.fn();
    await expect(provisionExecutionWorkspaceForFreshnessDecision({
      requestedShouldReuseExisting: false,
      issueRef: { id: "child" },
      runId: "run-1",
      workspaceConfigFreshness: freshness,
      realizeWorkspace: async () => { throw new Error("disk full"); },
      realizeIsolatedWorkspace,
    })).rejects.toThrow("disk full");
    expect(realizeIsolatedWorkspace).not.toHaveBeenCalled();
  });
});
