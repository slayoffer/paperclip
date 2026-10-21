import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Source issues in this set make the blocking-graph read throw, so a test can
// prove that one failing record does not stop the recovery sweep.
const poisonedSourceIssueIds = vi.hoisted(() => new Set<string>());

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return {
    ...actual,
    listIssuesTransitivelyBlockedBy: async (
      ...args: Parameters<typeof actual.listIssuesTransitivelyBlockedBy>
    ) => {
      if (poisonedSourceIssueIds.has(args[2])) {
        throw new Error("simulated reconcile failure");
      }
      return actual.listIssuesTransitivelyBlockedBy(...args);
    },
  };
});

const { recoveryService } = await import("../services/recovery/service.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery blocking-cycle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("active recovery reconcile and blocking cycles (SYNA-2368)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("recovery-blocking-cycle-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Blocking cycle fixture",
      issuePrefix: `B${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    title: string;
    status: string;
    parentId?: string;
    unassigned?: boolean;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: input.title,
      status: input.status,
      parentId: input.parentId ?? null,
      // An unassigned todo issue is not a stranded-sweep candidate.
      assigneeAgentId: input.unassigned ? null : input.agentId,
      responsibleUserId: "fixture-owner",
    });
    return id;
  }

  async function seedBoardAction(companyId: string, sourceIssueId: string) {
    return db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "missing_disposition",
        status: "active",
        ownerType: "board",
        cause: "successful_run_missing_issue_disposition",
        fingerprint: `missing-disposition:${sourceIssueId}`,
        nextAction: "Choose a valid issue disposition.",
        attemptCount: 1,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function blocks(companyId: string, blockerIssueId: string, blockedIssueId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
  }

  async function readAction(id: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, id))
      .then((rows) => rows[0]!);
  }

  async function blockersOf(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  it("does not block a source on a healthy child that already waits on the source", async () => {
    const { companyId, agentId } = await seedCompany();
    // The real case: parent SYNA-1939 and child SYNA-2286, which waits for the
    // parent's PR. The child is healthy only because the parent blocks it.
    const sourceId = await seedIssue({ companyId, agentId, title: "Parent", status: "blocked" });
    const childId = await seedIssue({
      companyId,
      agentId,
      title: "Child waits for the parent's PR",
      status: "blocked",
      parentId: sourceId,
    });
    await blocks(companyId, sourceId, childId);
    const action = await seedBoardAction(companyId, sourceId);

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.failed).toBe(0);
    expect(await blockersOf(companyId, sourceId)).toEqual([]);
    expect(await blockersOf(companyId, childId)).toEqual([sourceId]);
    // No safe child is left, so the action stays for the board.
    expect(await readAction(action.id)).toMatchObject({ status: "active", ownerType: "board" });
  });

  it("also ignores a healthy child that waits on the source through another issue", async () => {
    const { companyId, agentId } = await seedCompany();
    const sourceId = await seedIssue({ companyId, agentId, title: "Parent", status: "blocked" });
    const middleId = await seedIssue({ companyId, agentId, title: "Middle", status: "blocked" });
    const childId = await seedIssue({
      companyId,
      agentId,
      title: "Child",
      status: "blocked",
      parentId: sourceId,
    });
    await blocks(companyId, sourceId, middleId);
    await blocks(companyId, middleId, childId);
    const action = await seedBoardAction(companyId, sourceId);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();

    expect(result.failed).toBe(0);
    expect(await blockersOf(companyId, sourceId)).toEqual([]);
    expect(await readAction(action.id)).toMatchObject({ status: "active" });
  });

  it("still blocks the source on an independent healthy child", async () => {
    const { companyId, agentId } = await seedCompany();
    const sourceId = await seedIssue({ companyId, agentId, title: "Parent", status: "blocked" });
    const otherId = await seedIssue({ companyId, agentId, title: "Other work", status: "todo", unassigned: true });
    const childId = await seedIssue({
      companyId,
      agentId,
      title: "Child waits for other work",
      status: "blocked",
      parentId: sourceId,
    });
    await blocks(companyId, otherId, childId);
    const action = await seedBoardAction(companyId, sourceId);

    await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();

    expect(await blockersOf(companyId, sourceId)).toEqual([childId]);
    expect(await readAction(action.id)).toMatchObject({
      status: "resolved",
      resolutionNote: "durable_path_restored:healthy_child",
    });
  });

  it("continues with the other actions when one action's reconcile throws", async () => {
    const { companyId, agentId } = await seedCompany();
    const poisonedId = await seedIssue({ companyId, agentId, title: "Poisoned", status: "blocked" });
    const otherId = await seedIssue({ companyId, agentId, title: "Other work", status: "todo", unassigned: true });
    const poisonedChildId = await seedIssue({
      companyId,
      agentId,
      title: "Poisoned child",
      status: "blocked",
      parentId: poisonedId,
    });
    await blocks(companyId, otherId, poisonedChildId);
    const poisonedAction = await seedBoardAction(companyId, poisonedId);
    const finishedId = await seedIssue({ companyId, agentId, title: "Finished", status: "done" });
    const finishedAction = await seedBoardAction(companyId, finishedId);
    poisonedSourceIssueIds.add(poisonedId);

    try {
      const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();
      expect(result.failed).toBe(1);
    } finally {
      poisonedSourceIssueIds.delete(poisonedId);
    }

    expect(await readAction(poisonedAction.id)).toMatchObject({ status: "active" });
    expect(await readAction(finishedAction.id)).toMatchObject({
      status: "resolved",
      resolutionNote: "source_terminal",
    });
  });
});
