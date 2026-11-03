import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces,
  issueThreadInteractions, nativeRunFinalizations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { addReleasedNativeController, git, terminalWorkspaceFixture } from "./helpers/terminal-workspace-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService, executeIssuePostCommitActions, type IssuePostCommitAction } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { logger } from "../middleware/logger.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

describe("issue terminal workspace cleanup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];

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

  const fixture = () => terminalWorkspaceFixture(db, directories);
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

  it.each([false, true])("holds duplicate physical owners with symlink=%s", async (useSymlink) => {
    const f = await fixture();
    const first = await f.workspace();
    const aliasPath = useSymlink ? join(f.root, "alias") : first.cwd!;
    if (useSymlink) await symlink(first.cwd!, aliasPath);
    const second = await f.workspace({ cwd: aliasPath, providerRef: aliasPath });
    const log = vi.spyOn(logger, "warn");
    await issueService(db).update(f.issue.id, { status: "done" });
    for (const row of [first, second]) {
      expect((await readWorkspace(row.id)).status).toBe("active");
      expect(existsSync(row.cwd!)).toBe(true);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: row.id,
        reasons: expect.arrayContaining(["Multiple workspace rows own this checkout. Resolve them before automatic close."]),
      }), "Skipped terminal workspace close");
    }
  });

  it.each(["dirty", "untracked", "unpushed", "unpushed merged", "runtime", "open link", "active run",
    "failed pid", "failed group", "failed controller", "failed native lease"])("keeps %s workspaces active and logs the reason", async (blocker) => {
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
    if (blocker === "active run" || blocker.startsWith("failed")) {
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Worker" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, issueId: f.issue.id,
        status: blocker === "active run" ? "running" : "failed",
        ...(blocker === "failed native lease" ? { runtimeMode: "native", nativeIssueId: f.issue.id } : {}),
        ...(blocker === "failed pid" ? { processPid: process.pid } : {}),
        ...(blocker === "failed group" ? { processGroupId: Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()) } : {}),
        ...(blocker === "failed controller" ? { controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
      }).returning();
      if (blocker === "failed native lease") await db.insert(nativeRunFinalizations).values({
        runId: run.id, companyId: f.company.id, issueId: f.issue.id, phase: "retryable_failure",
        leaseOwner: "test-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
      });
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

  it.each([
    ["source", false], ["linked", false], ["source", true], ["linked", true],
  ])("keeps an open %s owner with symlink=%s", async (association, useSymlink) => {
    const f = await fixture();
    const row = await f.workspace();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Open owner", status: "todo" }).returning();
    const aliasPath = useSymlink ? join(f.root, "alias") : row.cwd!;
    if (useSymlink) await symlink(row.cwd!, aliasPath);
    const alias = await f.workspace({ cwd: aliasPath, providerRef: aliasPath,
      sourceIssueId: association === "source" ? other.id : null });
    if (association === "linked") await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, other.id));
    await issueService(db).update(f.issue.id, { status: "cancelled" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
  });

  it.each([
    { useSymlink: false, consumer: "run" }, { useSymlink: true, consumer: "run" },
    { useSymlink: false, consumer: "taskId run" },
    { useSymlink: false, consumer: "service" }, { useSymlink: true, consumer: "service" },
    { useSymlink: false, consumer: "primary" }, { useSymlink: true, consumer: "primary" },
    { useSymlink: false, consumer: "shared" }, { useSymlink: true, consumer: "shared" },
  ])("keeps a terminal owner's $consumer with symlink=$useSymlink", async ({ useSymlink, consumer }) => {
    const f = await fixture();
    const row = await f.workspace();
    const [other] = await db.insert(issues).values({
      companyId: f.company.id, title: "Finishing owner", status: "done",
    }).returning();
    const aliasPath = useSymlink ? join(f.root, "alias") : row.cwd!;
    if (useSymlink) await symlink(row.cwd!, aliasPath);
    const alias = await f.workspace({ cwd: aliasPath, providerRef: aliasPath, sourceIssueId: other.id });
    if (consumer === "primary") {
      const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Other project" }).returning();
      const [primary] = await db.insert(projectWorkspaces).values({
        companyId: f.company.id, projectId: project.id, name: "Primary alias", cwd: row.cwd, isPrimary: true,
      }).returning();
      await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: primary.id })
        .where(eq(executionWorkspaces.id, alias.id));
    }
    if (consumer === "shared") await db.update(executionWorkspaces).set({ mode: "shared_workspace" })
      .where(eq(executionWorkspaces.id, alias.id));
    await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, other.id));
    if (consumer === "run" || consumer === "taskId run") {
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Finishing" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id, status: "running",
        ...(consumer === "run" ? { issueId: other.id } : { contextSnapshot: { taskId: other.id } }),
      }).returning();
      // The scope trigger binds a taskId-only insert to its existing issue.
      expect(run.issueId).toBe(other.id);
    } else if (consumer === "service") {
      await db.insert(workspaceRuntimeServices).values({
        id: randomUUID(), companyId: f.company.id, executionWorkspaceId: alias.id, cwd: aliasPath,
        scopeType: "execution_workspace", serviceName: "preview", status: "running", lifecycle: "persistent", provider: "process",
      });
    }
    await issueService(db).update(f.issue.id, { status: "done" });
    expect((await readWorkspace(row.id)).status).toBe("active");
    expect(existsSync(row.cwd!)).toBe(true);
    expect((await readWorkspace(alias.id)).status).toBe("active");
    if (consumer === "service") {
      expect(await db.select({ status: workspaceRuntimeServices.status }).from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.executionWorkspaceId, alias.id))).toEqual([{ status: "running" }]);
    }
  });

  it.each(["direct", "deferred", "rollback"])("applies native review cleanup after %s commit effects", async (mode) => {
    const f = await fixture();
    const row = await f.workspace();
    await addReleasedNativeController(db, f.company.id, f.issue.id);
    await db.update(issues).set({ status: "in_review", executionWorkspaceId: row.id }).where(eq(issues.id, f.issue.id));
    const [review] = await db.insert(issueThreadInteractions).values({
      companyId: f.company.id, issueId: f.issue.id, kind: "request_confirmation", status: "pending",
      addresseeUserId: "local-board", effectiveResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Review completed work.", target: {
        type: "custom", key: "native_completion_review", revisionId: randomUUID(),
      } },
    }).returning();
    const effects: Array<(committedDb: typeof db) => Promise<void>> = [];
    const accept = (target: typeof db) => issueThreadInteractionService(target).acceptInteraction(
      { ...f.issue, status: "in_review" }, review.id, {}, { userId: "local-board" },
      mode === "direct" ? undefined : { deferConfirmationCommitEffects: (effect) => effects.push(effect) },
    );
    if (mode === "direct") await accept(db);
    else {
      const transaction = db.transaction(async (tx) => {
        await accept(tx as unknown as typeof db);
        expect((await readWorkspace(row.id)).status).toBe("active");
        expect(existsSync(row.cwd!)).toBe(true);
        if (mode === "rollback") throw new Error("rollback review");
      });
      if (mode === "rollback") {
        await expect(transaction).rejects.toThrow("rollback review");
        expect((await readWorkspace(row.id)).status).toBe("active");
        expect(existsSync(row.cwd!)).toBe(true);
        expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("in_review");
        return;
      }
      await transaction;
      for (const effect of effects) await effect(db);
    }
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("done");
    expect((await readWorkspace(row.id)).status).toBe("archived");
    expect(existsSync(row.cwd!)).toBe(false);
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
