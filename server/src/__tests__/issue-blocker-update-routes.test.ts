import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issueComments, issueRelations, issues, projects, workspaceOperations } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("atomic blocker changes in issue follow-ups", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocker-update-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: `Blocker update ${randomUUID()}`,
      issuePrefix: `BU${randomUUID().slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Blocker owner",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }).returning();
    const [issue, first, second] = await db.insert(issues).values([
      { title: "Continue work", status: "blocked" },
      { title: "First prerequisite", status: "todo" },
      { title: "Second prerequisite", status: "todo" },
    ].map((row) => ({ ...row, companyId: company!.id, assigneeAgentId: agent!.id, responsibleUserId: "board-user" }))).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: agent!.id,
      status: "running",
      contextSnapshot: { issueId: issue!.id },
    }).returning();
    const actor: Express.Request["actor"] = {
      type: "agent", companyId: company!.id, agentId: agent!.id, runId: run!.id, source: "agent_jwt",
    };
    const app = (override = actor) => {
      const result = express();
      result.use(express.json());
      result.use((req, _res, next) => { req.actor = override; next(); });
      result.use("/api", issueRoutes(db, {} as any));
      result.use(errorHandler);
      return result;
    };
    const block = async (...blockerIds: string[]) => {
      await db.insert(issueRelations).values(blockerIds.map((id) => ({
        companyId: company!.id, issueId: id, relatedIssueId: issue!.id, type: "blocks",
      })));
    };
    const state = async () => ({
      issue: (await db.select().from(issues).where(eq(issues.id, issue!.id)))[0],
      blockers: (await db.select().from(issueRelations).where(and(
        eq(issueRelations.relatedIssueId, issue!.id), eq(issueRelations.type, "blocks"),
      ))).map((row) => row.issueId).sort(),
      comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id)),
    });
    return { company: company!, agent: agent!, issue: issue!, first: first!, second: second!, app, block, state };
  }

  it.each([
    { status: "todo" },
    { resume: true },
    { reopen: true },
  ])("removes the final unresolved blocker and resumes with %j", async (intent) => {
    const f = await fixture();
    await f.block(f.first.id);
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      ...intent, blockedByIssueIds: [], comment: "The prerequisite no longer applies.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await f.state();
    expect(saved.issue?.status).toBe("todo");
    expect(saved.blockers).toEqual([]);
    expect(saved.comments.map((row) => row.body)).toEqual(["The prerequisite no longer applies."]);
  });

  it("rejects advancement when the requested set retains an unresolved blocker", async () => {
    const f = await fixture();
    await f.block(f.first.id, f.second.id);
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [f.second.id], status: "todo", comment: "One prerequisite remains.",
    });
    expect(response.status).toBe(409);
    expect(response.body.details.unresolvedBlockerIssueIds).toEqual([f.second.id]);
    const saved = await f.state();
    expect(saved.issue?.status).toBe("blocked");
    expect(saved.blockers).toEqual([f.first.id, f.second.id].sort());
    expect(saved.comments).toEqual([]);
  });

  it("checks stored blockers when the request omits the replacement", async () => {
    const f = await fixture();
    await f.block(f.first.id);
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      status: "todo", comment: "Continue with the saved blockers.",
    });
    expect(response.status).toBe(409);
    expect(response.body.details.unresolvedBlockerIssueIds).toEqual([f.first.id]);
    expect((await f.state()).comments).toEqual([]);
  });

  it("rejects a new unresolved blocker even when the stored blocker is done", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.first.id));
    await f.block(f.first.id);
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [f.second.id], status: "todo", comment: "Replace the prerequisite.",
    });
    expect(response.status).toBe(409);
    expect(response.body.details.unresolvedBlockerIssueIds).toEqual([f.second.id]);
    expect((await f.state()).blockers).toEqual([f.first.id]);
  });

  it("accepts a completed replacement without reading the removed blocker", async () => {
    const f = await fixture();
    await f.block(f.first.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.second.id));
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [f.second.id], status: "todo", comment: "The replacement prerequisite is complete.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await f.state()).blockers).toEqual([f.second.id]);
  });

  it("rejects a dependency cycle after preview and rolls back the status", async () => {
    const f = await fixture();
    await f.block(f.first.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.second.id));
    await db.insert(issueRelations).values({
      companyId: f.company.id, issueId: f.issue.id, relatedIssueId: f.second.id, type: "blocks",
    });
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [f.second.id], status: "todo", comment: "Invalid cycle.",
    });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/cycle/i);
    const saved = await f.state();
    expect(saved.issue?.status).toBe("blocked");
    expect(saved.blockers).toEqual([f.first.id]);
    expect(saved.comments).toEqual([]);
  });

  it("rejects a blocker from another company and rolls back the status", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await f.block(f.first.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, foreign.first.id));
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [foreign.first.id], status: "todo", comment: "Invalid replacement.",
    });
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("Blocked-by issues must belong to the same company");
    const saved = await f.state();
    expect(saved.issue?.status).toBe("blocked");
    expect(saved.blockers).toEqual([f.first.id]);
    expect(saved.comments).toEqual([]);
  });

  it("preserves the workspace finalization barrier for proposed blockers", async () => {
    const f = await fixture();
    await f.block(f.first.id);
    const [project] = await db.insert(projects).values({ companyId: f.company.id, name: "Prerequisite workspace" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: f.company.id, projectId: project!.id, sourceIssueId: f.second.id,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Prerequisite workspace",
    }).returning();
    await db.update(issues).set({ status: "done", executionWorkspaceId: workspace!.id }).where(eq(issues.id, f.second.id));
    await db.insert(workspaceOperations).values({
      companyId: f.company.id, executionWorkspaceId: workspace!.id, issueId: f.second.id,
      phase: "workspace_finalize", status: "running",
    });
    const response = await request(f.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [f.second.id], status: "todo", comment: "The replacement still synchronizes.",
    });
    expect(response.status).toBe(409);
    expect(response.body.details.unresolvedBlockerIssueIds).toEqual([f.second.id]);
    expect((await f.state()).blockers).toEqual([f.first.id]);
    expect((await f.state()).comments).toEqual([]);
  });

  it("preserves company authorization before the blocker preview", async () => {
    const f = await fixture();
    const other = await fixture();
    await f.block(f.first.id);
    const response = await request(other.app()).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: [], status: "todo", comment: "Unauthorized replacement.",
    });
    expect(response.status).toBe(404);
    expect((await f.state()).blockers).toEqual([f.first.id]);
  });

  it.each([false, true])("uses the requested set for board resume intent (retains blocker: %s)", async (retain) => {
    const f = await fixture();
    await f.block(f.first.id);
    const response = await request(f.app({
      type: "board", userId: "board-user", companyIds: [f.company.id],
      source: "local_implicit", isInstanceAdmin: true,
    })).patch(`/api/issues/${f.issue.id}`).send({
      blockedByIssueIds: retain ? [f.first.id] : [], resume: true, comment: "Resume with the proposed prerequisites.",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(retain ? 409 : 200);
    expect((await f.state()).issue?.status).toBe(retain ? "blocked" : "todo");
  });
});
