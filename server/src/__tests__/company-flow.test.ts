import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, approvals, companies, createDb, heartbeatRuns, issueApprovals,
  executionWorkspaces, issueRelations, issues, issueThreadInteractions, projects, workspaceOperations,
} from "@paperclipai/db";
import type { CompanyFlowReport } from "@paperclipai/shared/types/company-flow";
import { companyFlowRoutes } from "../routes/company-flow.js";
import { countAgentActiveIssues } from "../services/agent-wip-limit.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Company flow database tests skipped: ${support.reason}`);

(support.supported ? describe : describe.skip)("company flow board route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let server: Server;
  let baseUrl: string;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const ids = Array.from({ length: 12 }, () => randomUUID());

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_WIP_LIMIT", "3");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-flow-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Flow", issuePrefix: "FLOW" },
      { id: otherCompanyId, name: "Private company", issuePrefix: "PRIVATE" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Owner", role: "engineer", adapterType: "codex_local" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Private owner", role: "engineer", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values(ids.map((id, index) => ({
      id, companyId: index === 11 ? otherCompanyId : companyId,
      assigneeAgentId: index === 11 ? otherAgentId : agentId,
      title: index === 11 ? "Private issue" : `Task ${index}`,
      identifier: index === 11 ? "PRIVATE-1" : `FLOW-${index + 1}`,
      status: ["todo", "backlog", "todo", "todo", "in_progress", "in_progress", "blocked", "done", "todo", "todo", "todo", "todo"][index],
      hiddenAt: index === 10 ? new Date() : null,
    })));
    const liveRunId = randomUUID();
    const endedRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: liveRunId, companyId, agentId, status: "running", nativeIssueId: ids[5] },
      { id: endedRunId, companyId, agentId, status: "running", finishedAt: new Date(), nativeIssueId: ids[4] },
      { companyId: otherCompanyId, agentId: otherAgentId, status: "running", contextSnapshot: { issueId: ids[4] } },
    ]);
    // An old pointer must not hide a ghost after a run finishes.
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ executionRunId: endedRunId }).where(eq(issues.id, ids[4]!));
    await db.insert(issueRelations).values([
      { companyId, issueId: ids[0]!, relatedIssueId: ids[2]!, type: "blocks" },
      { companyId, issueId: ids[7]!, relatedIssueId: ids[6]!, type: "blocks" },
      { companyId, issueId: ids[11]!, relatedIssueId: ids[0]!, type: "blocks" },
      { companyId, issueId: ids[0]!, relatedIssueId: ids[11]!, type: "blocks" },
    ]);
    await db.insert(issueThreadInteractions).values([
      { companyId, issueId: ids[3]!, kind: "request_confirmation", payload: { version: 1, prompt: "Approve this task?" } },
      { companyId, issueId: ids[0]!, kind: "request_confirmation", status: "accepted", payload: { version: 1, prompt: "Approved." } },
      { companyId: otherCompanyId, issueId: ids[0]!, kind: "request_confirmation", payload: { version: 1, prompt: "Private decision" } },
    ]);
    const approvalId = randomUUID();
    const privateApprovalId = randomUUID();
    await db.insert(approvals).values([
      { id: approvalId, companyId, type: "approve_ceo_strategy", status: "revision_requested", payload: {} },
      { id: privateApprovalId, companyId: otherCompanyId, type: "approve_ceo_strategy", payload: {} },
    ]);
    await db.insert(issueApprovals).values([
      { companyId, issueId: ids[8]!, approvalId },
      { companyId, issueId: ids[9]!, approvalId: privateApprovalId },
    ]);
    const app = express();
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor") ?? "board";
      req.actor = actor === "agent"
        ? { type: "agent", agentId, companyId, source: "agent_key" }
        : actor === "anonymous"
          ? { type: "none" }
          : { type: "board", source: actor === "local" ? "local_implicit" : "session", companyIds: actor === "outsider" ? [] : [companyId] };
      next();
    });
    app.use("/api", companyFlowRoutes(db));
    const onError: ErrorRequestHandler = (err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message });
    app.use(onError);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
    baseUrl = `http://127.0.0.1:${address.port}/api/companies`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()) ?? resolve());
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  it("enforces board access and company membership before queries", async () => {
    for (const actor of ["anonymous", "outsider"]) {
      const response = await fetch(`${baseUrl}/${companyId}/flow`, { headers: { "x-test-actor": actor } });
      expect(response.status).toBe(403);
    }
    expect((await fetch(`${baseUrl}/${otherCompanyId}/flow`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/${randomUUID()}/flow`, { headers: { "x-test-actor": "local" } })).status).toBe(404);
  });

  it("refuses an agent principal with HTTP 403", async () => {
    const response = await fetch(`${baseUrl}/${companyId}/flow`, { headers: { "x-test-actor": "agent" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Board access required" });
  });

  it("uses scoped database rows, pending decisions, exact WIP, and live runs", async () => {
    const response = await fetch(`${baseUrl}/${companyId}/flow`);
    expect(response.status).toBe(200);
    const report = await response.json() as CompanyFlowReport;
    expect(report.companyId).toBe(companyId);
    expect(report.readyQueues[0]?.todo.map((issue) => issue.id).sort()).toEqual([ids[0], ids[9]].sort());
    expect(report.readyQueues[0]?.backlog.map((issue) => issue.id)).toEqual([ids[1]]);
    expect(report.chainRoots.map((root) => [root.issue.id, root.transitiveDependentCount])).toEqual([[ids[0], 1]]);
    expect(report.agents).toEqual([expect.objectContaining({ id: agentId, atWipLimit: true, wipLimit: 3 })]);
    expect(report.agents[0]?.wip).toBe(await countAgentActiveIssues(db, { companyId, agentId }));
    expect(report.ghosts.inProgressWithoutRun.map((issue) => issue.id)).toEqual([ids[4]]);
    expect(report.ghosts.blockedWithClosedLinks.map((issue) => issue.id)).toEqual([ids[6]]);
    expect(JSON.stringify(report)).not.toMatch(/Private|PRIVATE/);
    expect(JSON.stringify(report)).not.toContain(ids[11]);
    expect(JSON.stringify(report)).not.toContain(otherAgentId);
    // Reading the report must preserve the real assignment count, including hidden issues.
    expect(report.agents[0]?.wip).toBe(9);
  });

  it("keeps done blockers unresolved until their workspace finalization succeeds", async () => {
    const scopedCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const blockerId = randomUUID();
    const unrelatedId = randomUUID();
    const dependents = ["todo", "backlog", "blocked"].map((status) => ({ id: randomUUID(), status }));
    await db.insert(companies).values({ id: scopedCompanyId, name: "Finalization", issuePrefix: "FINAL" });
    await db.insert(projects).values({ id: projectId, companyId: scopedCompanyId, name: "Finalization" });
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId: scopedCompanyId, projectId, name: "Shared workspace",
      mode: "isolated", strategyType: "git_worktree",
    });
    await db.insert(issues).values([
      { id: blockerId, companyId: scopedCompanyId, title: "Done blocker", status: "done", executionWorkspaceId: workspaceId },
      { id: unrelatedId, companyId: scopedCompanyId, title: "Other workspace user", status: "done", executionWorkspaceId: workspaceId },
      ...dependents.map(({ id, status }) => ({ id, status, companyId: scopedCompanyId, title: `Dependent ${status}` })),
    ]);
    await db.insert(issueRelations).values(dependents.map(({ id }) => ({
      companyId: scopedCompanyId, issueId: blockerId, relatedIssueId: id, type: "blocks" as const,
    })));
    const readReport = async () => {
      const response = await fetch(`${baseUrl}/${scopedCompanyId}/flow`, { headers: { "x-test-actor": "local" } });
      expect(response.status).toBe(200);
      return response.json() as Promise<CompanyFlowReport>;
    };
    const expectReleased = (report: CompanyFlowReport) => {
      expect(report.counts.readyTodo).toBe(1);
      expect(report.counts.readyBacklog).toBe(1);
      expect(report.ghosts.blockedWithClosedLinks.map((issue) => issue.id)).toEqual([dependents[2]!.id]);
    };
    const expectWaiting = (report: CompanyFlowReport) => {
      expect(report.readyQueues).toEqual([]);
      expect(report.ghosts.blockedWithClosedLinks).toEqual([]);
    };
    const recordOperation = async (phase: string, status: string, offset: number, issueId: string | null = blockerId, opCompanyId = scopedCompanyId) => {
      await db.insert(workspaceOperations).values({
        companyId: opCompanyId, executionWorkspaceId: workspaceId, issueId, phase, status,
        startedAt: new Date(Date.UTC(2026, 9, 19, 0, offset)),
      });
    };
    // An untouched workspace needs no finalization.
    expectReleased(await readReport());
    for (const [index, [phase, status]] of [
      ["worktree_prepare", "succeeded"], ["workspace_finalize", "running"],
      ["workspace_finalize", "failed"], ["workspace_finalize", "skipped"],
    ].entries()) {
      await recordOperation(phase!, status!, index + 1);
      expectWaiting(await readReport());
    }
    // Another company's finalize cannot release this company's dependents.
    await recordOperation("workspace_finalize", "succeeded", 5, null, otherCompanyId);
    expectWaiting(await readReport());
    // A later success on this shared workspace clears the blocker's barrier.
    await recordOperation("workspace_finalize", "succeeded", 6, unrelatedId);
    expectReleased(await readReport());
    // Later work for a different issue does not reopen this blocker's barrier.
    await recordOperation("worktree_prepare", "succeeded", 7, unrelatedId);
    expectReleased(await readReport());
    await recordOperation("worktree_prepare", "succeeded", 8);
    expectWaiting(await readReport());
    await recordOperation("workspace_finalize", "succeeded", 9);
    expectReleased(await readReport());
  });

  it("returns a complete company report within two seconds for 2,000 issues", async () => {
    const loadIds = Array.from({ length: 2_000 }, () => randomUUID());
    await db.insert(issues).values(loadIds.map((id, index) => ({
      id, companyId, title: `Load ${index}`, assigneeAgentId: agentId,
      status: index % 4 === 0 ? "backlog" : "todo",
    })));
    // Include long dependency chains and shared descendants, not only independent tasks.
    await db.insert(issueRelations).values(loadIds.slice(1).map((id, index) => ({
      companyId, issueId: loadIds[index]!, relatedIssueId: id, type: "blocks" as const,
    })));
    const start = performance.now();
    const response = await fetch(`${baseUrl}/${companyId}/flow`);
    const report = await response.json() as CompanyFlowReport;
    const elapsed = performance.now() - start;
    expect(response.status).toBe(200);
    expect(report.chainRoots[0]?.transitiveDependentCount).toBe(1_999);
    expect(report.chainRoots).toHaveLength(2_000);
    expect(elapsed).toBeLessThan(2_000);
    console.info(`Company flow HTTP report: 2,011 company issues, 2,003 relations, ${Math.round(elapsed)} ms`);
  }, 15_000);

  it("keeps shared workspace history below two seconds for five complete reads", async () => {
    const historyCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const unrelatedId = randomUUID();
    const blockers = Array.from({ length: 250 }, () => randomUUID());
    const dependents = blockers.flatMap((blockerId) => Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(), blockerId, status: index < 4 ? "blocked" : "done",
    })));
    await db.insert(companies).values({ id: historyCompanyId, name: "History", issuePrefix: "HISTORY" });
    await db.insert(projects).values({ id: projectId, companyId: historyCompanyId, name: "History" });
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId: historyCompanyId, projectId, name: "Shared history",
      mode: "isolated", strategyType: "git_worktree",
    });
    const rows = [
      ...blockers.map((id) => ({ id, status: "done", executionWorkspaceId: workspaceId })),
      ...dependents.map(({ id, status }) => ({ id, status, executionWorkspaceId: null })),
      { id: unrelatedId, status: "done", executionWorkspaceId: workspaceId },
    ];
    for (let start = 0; start < rows.length; start += 250) {
      await db.insert(issues).values(rows.slice(start, start + 250).map((row) => ({
        ...row, companyId: historyCompanyId, title: "History fixture",
      })));
    }
    await db.insert(issueRelations).values(dependents.map(({ id, blockerId }) => ({
      companyId: historyCompanyId, issueId: blockerId, relatedIssueId: id, type: "blocks" as const,
    })));
    const operations = [
      ...blockers.map((issueId) => ({ issueId, phase: "worktree_prepare", status: "succeeded" })),
      ...Array.from({ length: 8_000 }, () => ({ issueId: unrelatedId, phase: "worktree_prepare", status: "succeeded" })),
    ];
    for (let start = 0; start < operations.length; start += 250) {
      await db.insert(workspaceOperations).values(operations.slice(start, start + 250).map((operation) => ({
        ...operation, companyId: historyCompanyId, executionWorkspaceId: workspaceId,
        startedAt: new Date("2026-10-20T00:00:00Z"),
      })));
    }
    // A later shared success must release every blocker, including those with duplicate links.
    await db.insert(workspaceOperations).values({
      companyId: historyCompanyId, executionWorkspaceId: workspaceId, issueId: unrelatedId,
      phase: "workspace_finalize", status: "succeeded", startedAt: new Date("2026-10-21T00:00:00Z"),
    });
    const timings: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/${historyCompanyId}/flow`, { headers: { "x-test-actor": "local" } });
      const report = await response.json() as CompanyFlowReport;
      timings.push(performance.now() - start);
      expect(response.status).toBe(200);
      expect(Object.keys(report).sort()).toEqual([
        "agents", "chainRoots", "collectedAt", "companyId", "counts", "ghosts", "readyQueues", "scorecard", "unassigned",
      ]);
      expect(report.ghosts.blockedWithClosedLinks).toHaveLength(1_000);
      expect(report.counts.wip).toBe(1_000);
    }
    const median = [...timings].sort((a, b) => a - b)[2]!;
    expect(median).toBeLessThan(2_000);
    console.info(`Company flow shared history HTTP reads (ms): ${timings.map(Math.round).join(", ")}. Median: ${Math.round(median)}`);
  }, 30_000);
});
