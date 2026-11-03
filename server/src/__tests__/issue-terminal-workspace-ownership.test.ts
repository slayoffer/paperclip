import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, createDb, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues, projects, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import { readProcessStartedAt } from "../services/hot-restart.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { git, terminalWorkspaceFixture } from "./helpers/terminal-workspace-fixture.js";

describe("terminal workspace removal boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-close-ownership-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  afterAll(async () => { await database?.cleanup(); });
  const fixture = () => terminalWorkspaceFixture(db, directories);
  const status = (id: string) => db.select().from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, id)).then(([row]) => row.status);
  async function publishChild(cwd: string) {
    const child = join(cwd, "app");
    await mkdir(child);
    await writeFile(join(child, "tracked"), "child project\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "add child project");
    git(cwd, "push", "origin", "HEAD");
    return child;
  }

  it.each(["context", "archived context", "legacy path", "legacy nested path", "native", "native path", "native nested path"])("keeps a live saved %s binding after the issue moves", async (binding) => {
    const f = await fixture();
    const workspace = await f.workspace();
    const cwd = binding.endsWith("nested path") ? await publishChild(workspace.cwd!) : workspace.cwd!;
    const savedId = binding === "archived context" ? (await f.workspace({
      cwd, providerRef: cwd, status: "archived", sourceIssueId: null,
    })).id : workspace.id;
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Moved owner",
      status: "in_progress", executionWorkspaceId: workspace.id }).returning();
    const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Owner" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: agent.id,
      issueId: other.id, status: "running",
      ...(binding.startsWith("legacy") ? { contextSnapshot: { paperclipWorkspace: { cwd } } } : binding.includes("context") ? { contextSnapshot: { executionWorkspaceId: savedId } } : {
        runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: binding === "native"
          ? { binding: { executionWorkspaceId: workspace.id } }
          : { workspace: { cwd } } },
      }),
    });
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, other.id));
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(await status(workspace.id)).toBe("active");
    expect(existsSync(cwd)).toBe(true);
  });

  it.each(["provider", "codex", "sidecar", "agent", "event", "ambiguous", "recycled", "remote"])(
    "checks retained native provider ownership: %s", async (kind) => {
      const f = await fixture();
      const workspace = await f.workspace();
      const [agent] = await db.insert(agents).values({ companyId: f.company.id, name: "Native owner" }).returning();
      const startedAt = await readProcessStartedAt(process.pid);
      expect(startedAt).not.toBeNull();
      const prefix = ["event", "ambiguous", "recycled", "remote"].includes(kind) ? "provider" : kind;
      const expectedStart = kind === "recycled" ? "2000-01-01T00:00:00.000Z" : startedAt!;
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.company.id, agentId: agent.id, status: "failed", runtimeMode: "native",
        contextSnapshot: { paperclipEnvironment: { driver: kind === "remote" ? "sandbox" : "local" } },
        runnerProfileJson: {
          nativeExecutionInput: { workspace: { cwd: workspace.cwd } },
          sessionCheckpoint: { process: kind === "event" ? {} : {
            [`${prefix}Pid`]: process.pid,
            ...(kind === "ambiguous" ? {} : { [`${prefix}ProcessStartedAt`]: expectedStart }),
          } },
        },
      }).returning();
      if (kind === "event") await db.insert(heartbeatRunEvents).values({
        companyId: f.company.id, agentId: agent.id, runId: run.id, seq: 1,
        eventType: "session.started", payload: { prpEvent: { payload: {
          processId: process.pid,
        } } },
      });
      await issueService(db).update(f.issue.id, { status: "done" });
      const holds = kind !== "recycled" && kind !== "remote";
      expect(await status(workspace.id)).toBe(holds ? "active" : "archived");
      expect(existsSync(workspace.cwd!)).toBe(holds);
    },
  );

  it.each(["removed config", "nested path", "stopped"])("checks persisted runtime ownership: %s", async (kind) => {
    const f = await fixture();
    const workspace = await f.workspace({ metadata: { config: { workspaceRuntime: { services: [] } } } });
    const cwd = kind === "nested path" ? await publishChild(workspace.cwd!) : workspace.cwd;
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(), companyId: f.company.id,
      executionWorkspaceId: kind === "nested path" ? null : workspace.id,
      scopeType: "execution_workspace", serviceName: "removed-preview", cwd,
      status: kind === "stopped" ? "stopped" : "running", lifecycle: "persistent", provider: "process",
    });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(await status(workspace.id)).toBe(kind === "stopped" ? "archived" : "active");
    expect(existsSync(workspace.cwd!)).toBe(kind !== "stopped");
  });

  it.each([
    ["primary", false], ["primary", true], ["workspace", false], ["workspace", true],
  ])("preserves nested %s ownership with symlink=%s", async (kind, alias) => {
    const f = await fixture();
    const workspace = await f.workspace();
    const child = await publishChild(workspace.cwd!);
    const cwd = alias ? join(f.root, "alias") : child;
    if (alias) await symlink(child, cwd);
    if (kind === "primary") {
      const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Child project" }).returning();
      await db.insert(projectWorkspaces).values({ companyId: f.company.id, projectId: project.id,
        name: "Primary", cwd, isPrimary: true });
    } else await f.workspace({ cwd, providerRef: cwd, sourceIssueId: null, mode: "shared_workspace" });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(await status(workspace.id)).toBe("active");
    expect(existsSync(child)).toBe(true);
  });

  it("does not confuse a sibling path prefix with a contained primary directory", async () => {
    const f = await fixture();
    const workspace = await f.workspace();
    const sibling = `${workspace.cwd}-app`;
    await mkdir(sibling);
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Sibling" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.company.id, projectId: project.id,
      name: "Primary", cwd: sibling, isPrimary: true });
    await issueService(db).update(f.issue.id, { status: "done" });
    expect(await status(workspace.id)).toBe("archived");
    expect(existsSync(sibling)).toBe(true);
  });
});
