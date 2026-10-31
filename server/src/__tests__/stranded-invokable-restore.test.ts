import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// 2026-10-31: a budget pause made Reviewer·Codex not invokable, the sweep blocked
// its 8 review issues for the board, and nothing reopened them after the resume.
(support.supported ? describe : describe.skip)("stranded recovery after the assignee can run again", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("stranded-invokable-restore-");
    db = createDb(temporary.connectionString);
  }, 20_000);
  beforeEach(() => { vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seedPausedAssignee() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restore fixture", issuePrefix: `S${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", status: "paused",
      pauseReason: "budget", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review PR", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    return { agentId, issueId };
  }
  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const actionsFor = (issueId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));

  it("hands the issue back as todo and dispatches it once the assignee is invokable", async () => {
    const { agentId, issueId } = await seedPausedAssignee();
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();
    expect((await readIssue(issueId)).status).toBe("blocked");
    expect(await actionsFor(issueId)).toEqual([expect.objectContaining({ status: "active",
      evidence: expect.objectContaining({ escalationReason: "assignee_not_invokable", previousStatus: "todo" }) })]);

    await recovery.reconcileStrandedAssignedIssues();
    expect((await readIssue(issueId)).status).toBe("blocked");

    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, agentId));
    await recovery.reconcileStrandedAssignedIssues();
    expect(await readIssue(issueId)).toMatchObject({ status: "todo", unblockDescriptor: null });
    expect(await actionsFor(issueId)).toEqual([expect.objectContaining({ status: "resolved", outcome: "restored",
      resolutionNote: "assignee_invokable_again" })]);

    await recovery.reconcileStrandedAssignedIssues();
    const dispatches = enqueueWakeup.mock.calls.filter(call => (call as unknown[])[0] === agentId) as unknown as
      Array<[string, { reason?: string; payload?: { issueId?: string } }]>;
    expect(dispatches).toEqual([[agentId, expect.objectContaining({ reason: "issue_assigned", payload: expect.objectContaining({ issueId }) })]]);
  });

  it("leaves the board escalation alone when the issue moved to another assignee", async () => {
    const { agentId, issueId } = await seedPausedAssignee();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    await recovery.reconcileStrandedAssignedIssues();
    const [other] = await db.insert(agents).values({ companyId: (await readIssue(issueId)).companyId, name: "Other",
      role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    await db.update(issues).set({ assigneeAgentId: other!.id }).where(eq(issues.id, issueId));
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, agentId));
    await recovery.reconcileStrandedAssignedIssues();
    expect((await readIssue(issueId)).status).toBe("blocked");
    expect(await actionsFor(issueId)).toEqual([expect.objectContaining({ status: "active" })]);
  });
});
