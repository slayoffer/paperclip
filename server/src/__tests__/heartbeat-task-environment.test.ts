import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { clearCompanyFixtures } from "./helpers/clear-company-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as orchestrator from "../services/environment-run-orchestrator.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { cleanupExecutionWorkspaceArtifacts } from "../services/workspace-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const macId = "18371c35-0974-424d-aa10-fd08096e27aa";
const sharedWorkspaceId = "f8c31a53-e167-4428-b099-19fe32c17aad";
const execFileAsync = promisify(execFile);

suite("task environment routing", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let directory: string;
  const selected: string[] = [];
  const originalFactory = orchestrator.environmentRunOrchestrator;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("task-environment-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  }, 60_000);

  afterEach(async () => {
    await heartbeat?.drainActiveRunExecutions();
    vi.restoreAllMocks();
    await clearCompanyFixtures(db);
    await db.delete(environments).where(eq(environments.id, macId));
    if (directory) await rm(directory, { recursive: true, force: true });
    selected.length = 0;
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function fixture(environmentPatch: Record<string, unknown> = {}, isolated = false) {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const parentId = randomUUID(), targetId = randomUUID(), siblingId = randomUUID(), projectWorkspaceId = randomUUID();
    directory = await mkdtemp(join(tmpdir(), "task-environment-workspace-"));
    let baseCwd = directory;
    let workspaceCwd = directory;
    const mode = isolated ? "isolated_workspace" : "shared_workspace";
    if (isolated) {
      baseCwd = join(directory, "repository");
      workspaceCwd = join(directory, "parent-worktree");
      await mkdir(baseCwd);
    }
    // Cross-issue sharing requires a checkout with a readable, clean Git status.
    await execFileAsync("git", ["init", "--initial-branch=main", baseCwd]);
    await execFileAsync("git", ["-C", baseCwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Initial fixture"]);
    if (isolated) {
      await execFileAsync("git", ["-C", baseCwd, "worktree", "add", "-b", "parent", workspaceCwd]);
    }
    await db.insert(companies).values({ id: companyId, name: "Routing", issuePrefix: "SYNA", defaultResponsibleUserId: "owner" });
    // The suite uses a test transport. It never connects to the real Mac.
    await db.insert(environments).values({ id: macId, name: "mac-spike", driver: "ssh", config: {
      host: "mac.invalid", username: "test", port: 22, remoteWorkspacePath: "/test/workspace",
    }, ...environmentPatch });
    const local = await originalFactory(db).resolveEnvironment({ companyId,
      selectedEnvironmentId: "test-local", localEnvironmentId: "test-local" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      defaultEnvironmentId: local.id, adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Checkout", cwd: baseCwd, isPrimary: true });
    await db.insert(issues).values([
      { id: parentId, identifier: "SYNA-2184", title: "Parent" },
      { id: targetId, identifier: "SYNA-2455", title: "Target", parentId },
      { id: siblingId, identifier: "SYNA-2456", title: "Sibling", parentId },
    ].map((row) => ({ ...row, companyId, projectId, projectWorkspaceId, assigneeAgentId: agentId,
      responsibleUserId: "owner", status: "todo", executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode },
    })));
    await db.insert(executionWorkspaces).values({ id: sharedWorkspaceId, companyId, projectId, projectWorkspaceId,
      sourceIssueId: parentId, mode, strategyType: isolated ? "git_worktree" : "project_primary", name: "Parent checkout",
      cwd: workspaceCwd, providerType: isolated ? "git_worktree" : "local_fs",
      branchName: isolated ? "parent" : null, providerRef: isolated ? workspaceCwd : null,
      metadata: { config: { environmentId: local.id }, createdByRuntime: false },
    });
    await db.update(issues).set({ executionWorkspaceId: sharedWorkspaceId }).where(eq(issues.companyId, companyId));
    vi.spyOn(orchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args),
      acquireForRun: async (input) => {
        selected.push(input.selectedEnvironmentId);
        throw new Error("Test transport stops after environment selection");
      },
    }));
    heartbeat = heartbeatService(db);
    return { companyId, agentId, parentId, targetId, siblingId, localId: local.id };
  }

  async function invoke(agentId: string, issueId: string) {
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const result = await heartbeat.getRun(run!.id);
    expect(result?.status).toBe("failed");
    return result;
  }

  it.each([[false, false], [false, true], [true, false], [true, true]])("selects mac-spike and preserves the parent, sibling, workspace, and agent default (flag=%s, isolated=%s)", async (enabled, isolated) => {
    const fixtureData = await fixture({}, isolated);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: enabled });
    const mode = isolated ? "isolated_workspace" : "shared_workspace";
    const { agentId, parentId, targetId, siblingId, localId } = fixtureData;
    const [workspaceBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, sharedWorkspaceId));
    await issueService(db).update(targetId, { executionWorkspaceSettings: { mode, environmentId: macId } });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, sharedWorkspaceId))).toEqual([workspaceBefore]);
    const targetRun = await invoke(agentId, targetId);
    expect(targetRun?.error).toContain("Test transport stops");
    expect(selected).toEqual([macId]);
    const [target] = await db.select().from(issues).where(eq(issues.id, targetId));
    expect(target.executionWorkspaceId).not.toBe(sharedWorkspaceId);
    expect(target.executionWorkspaceSettings?.environmentId).toBe(macId);
    const [binding] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, target.executionWorkspaceId!));
    expect(binding.sourceIssueId).toBe(targetId);
    expect(binding.metadata?.config).toMatchObject({ environmentId: macId });
    expect(binding.derivedFromExecutionWorkspaceId).toBe(sharedWorkspaceId);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, sharedWorkspaceId))).toEqual([workspaceBefore]);
    for (const issueId of [parentId, siblingId]) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue.executionWorkspaceId).toBe(sharedWorkspaceId);
      expect(issue.executionWorkspaceSettings).toEqual({ mode });
      await invoke(agentId, issueId);
    }
    expect(selected).toEqual([macId, localId, localId]);
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].defaultEnvironmentId).toBe(localId);
  });

  it.each([
    [{ status: "archived" }, "archived"],
    [{ status: "paused" }, "Unexpected environment status"],
    [{ driver: "plugin" }, "not allowed"],
    [{ driver: "sandbox", config: { provider: "fake" } }, "probe-only"],
  ])("rejects unavailable or forbidden task environments (%s)", async (patch, message) => {
    const { agentId, targetId } = await fixture(patch);
    await db.update(issues).set({ executionWorkspaceSettings: { mode: "shared_workspace", environmentId: macId } }).where(eq(issues.id, targetId));
    const before = await db.select().from(executionWorkspaces);
    const run = await invoke(agentId, targetId);
    expect(run?.error).toContain(message);
    expect(selected).toEqual([]);
    expect(await db.select().from(executionWorkspaces)).toEqual(before);
  });

  it("rejects a removed environment before workspace changes", async () => {
    const { agentId, targetId } = await fixture();
    await db.delete(environments).where(eq(environments.id, macId));
    await db.update(issues).set({ executionWorkspaceSettings: { mode: "shared_workspace", environmentId: macId } }).where(eq(issues.id, targetId));
    const before = await db.select().from(executionWorkspaces);
    const run = await invoke(agentId, targetId);
    expect(run?.error).toContain("Environment not found");
    expect(selected).toEqual([]);
    expect(await db.select().from(executionWorkspaces)).toEqual(before);
  });

  it.each(["local_fs", "git_worktree"])("never removes the source checkout through a task environment binding (%s)", async (providerType) => {
    directory = await mkdtemp(join(tmpdir(), "borrowed-workspace-"));
    const file = join(directory, "source.txt");
    await writeFile(file, "parent checkout");
    const result = await cleanupExecutionWorkspaceArtifacts({ workspace: {
      id: randomUUID(), cwd: directory, providerType, providerRef: null, branchName: null,
      repoUrl: null, baseRef: null, projectId: null, projectWorkspaceId: null, sourceIssueId: null,
      metadata: { taskEnvironmentSourceWorkspaceId: sharedWorkspaceId, createdByRuntime: true },
    }, cleanupCommand: "exit 1", teardownCommand: "exit 1" });
    expect(result.cleaned).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("parent checkout");
  });
});
