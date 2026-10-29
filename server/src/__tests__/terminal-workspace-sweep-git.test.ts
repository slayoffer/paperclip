import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2026, 5, 1);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function git(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim();
}

describeEmbeddedPostgres("terminal workspace sweep git work", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();
  let nowMs = START_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-sweep-git-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
    tempDirs.clear();
    nowMs = START_MS;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The fake reports a dirty tracked file, or a clean tree.
  function fakeGit(dirty: boolean) {
    return vi.fn(async () => ({
      git: {
        repoRoot: null,
        workspacePath: null,
        hasDirtyTrackedFiles: dirty,
        hasUntrackedFiles: false,
        isMergedIntoBase: null,
      } as never,
      warnings: [],
      statusInspectionSucceeded: true,
    }));
  }

  function makeService(
    inspectGitCloseReadiness?: ReturnType<typeof fakeGit>,
    cooldownDays = 0,
    pullRequest?: { headRef: string; headSha: string },
  ) {
    return executionWorkspaceService(db, {
      inspectGitCloseReadiness,
      now: () => new Date(nowMs),
      workspaceReaperCooldownDays: cooldownDays,
      resolvePullRequestDetails: async () => pullRequest
        ? { state: "merged", ...pullRequest }
        : { state: "unknown", headRef: null, headSha: null },
    });
  }

  async function seedWorkspace(options: {
    issueStatus: "done" | "todo";
    completedAt?: Date;
    cwd?: string;
    branchName?: string;
    withPullRequest?: boolean;
  }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.slice(0, 8).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Sweep", status: "in_progress" });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `${issuePrefix}-1`,
      status: "active",
      cwd: options.cwd ?? `/nonexistent/${workspaceId}`,
      providerRef: options.cwd ?? `/nonexistent/${workspaceId}`,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName: options.branchName ?? "sweep-branch",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      identifier: `${issuePrefix}-1`,
      title: "Source issue",
      status: options.issueStatus,
      priority: "medium",
      executionWorkspaceId: workspaceId,
      completedAt: options.completedAt ?? null,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: issueId, updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(executionWorkspaces.id, workspaceId));
    if (options.withPullRequest) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        executionWorkspaceId: workspaceId,
        type: "pull_request",
        provider: "github",
        title: "Delivered PR",
        url: "https://github.com/paperclipai/paperclip/pull/1",
        status: "merged",
      });
    }
    return { companyId, workspaceId, issueId };
  }

  async function statusOf(workspaceId: string) {
    const [row] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId));
    return row?.status ?? null;
  }

  it("makes no git call for a workspace whose issue tree is not terminal", async () => {
    await seedWorkspace({ issueStatus: "todo" });
    const inspect = fakeGit(false);

    const sweep = await makeService(inspect).sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ checked: 1, skippedNonTerminalTree: 1, archived: 0 });
    expect(inspect).not.toHaveBeenCalled();
  }, 20_000);

  it("makes no git call for a workspace that is in its cooldown", async () => {
    const seeded = await seedWorkspace({
      issueStatus: "done",
      completedAt: new Date(START_MS - DAY_MS),
    });
    const inspect = fakeGit(true);

    const sweep = await makeService(inspect, 7).sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ checked: 1, skippedCooldown: 1, skippedDirty: 0, archived: 0 });
    expect(inspect).not.toHaveBeenCalled();
    expect(await statusOf(seeded.workspaceId)).toBe("active");
  }, 20_000);

  it("inspects a dirty terminal workspace once and skips it until the interval ends or the row changes", async () => {
    const seeded = await seedWorkspace({ issueStatus: "done", completedAt: new Date("2020-01-01T00:00:00Z") });
    const inspect = fakeGit(true);
    const service = makeService(inspect);

    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ skippedDirty: 1, archived: 0 });
    expect(inspect).toHaveBeenCalledTimes(1);

    nowMs += HOUR_MS;
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ skippedDirty: 1, skippedUndelivered: 1 });
    expect(inspect).toHaveBeenCalledTimes(1);

    // The row changed, so the verdict no longer applies.
    await db
      .update(executionWorkspaces)
      .set({ updatedAt: new Date("2020-01-02T00:00:00Z") })
      .where(eq(executionWorkspaces.id, seeded.workspaceId));
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ skippedDirty: 1 });
    expect(inspect).toHaveBeenCalledTimes(2);

    // The interval passed without a row change.
    nowMs += 6 * HOUR_MS + 1;
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ skippedDirty: 1 });
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(await statusOf(seeded.workspaceId)).toBe("active");
  }, 20_000);

  it("still archives a clean merged workspace after a fresh git check", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sweep-git-"));
    tempDirs.add(repoRoot);
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await git(repoRoot, ["config", "user.email", "test@paperclip.local"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "Initial commit"]);
    await git(repoRoot, ["branch", "-M", "main"]);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-sweep-wt-${randomUUID()}`);
    tempDirs.add(worktreePath);
    await git(repoRoot, ["branch", "sweep-delivery"]);
    await git(repoRoot, ["worktree", "add", worktreePath, "sweep-delivery"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await git(worktreePath, ["add", "delivered.txt"]);
    await git(worktreePath, ["commit", "-m", "Delivered change"]);
    const headSha = await git(worktreePath, ["rev-parse", "HEAD"]);
    const seeded = await seedWorkspace({
      issueStatus: "done",
      completedAt: new Date("2020-01-01T00:00:00Z"),
      cwd: worktreePath,
      branchName: "sweep-delivery",
      withPullRequest: true,
    });

    const sweep = await makeService(undefined, 0, { headRef: "sweep-delivery", headSha })
      .sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ archived: 1, skippedDirty: 0, skippedCooldown: 0 });
    expect(await statusOf(seeded.workspaceId)).toBe("archived");
  }, 30_000);
});
