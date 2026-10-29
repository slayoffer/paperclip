import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Updates of issues in this set fail with the HTTP 422 that the blocked-state
// integrity guard throws, so a test can prove that the sweep does not send the
// same refused write on every tick.
const refusedIssueIds = vi.hoisted(() => new Set<string>());
const refusedUpdates = vi.hoisted(() => new Map<string, number>());

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  const { unprocessable } = await import("../errors.js");
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const service = actual.issueService(...args);
      return {
        ...service,
        update: async (...updateArgs: Parameters<typeof service.update>) => {
          const issueId = updateArgs[0];
          if (refusedIssueIds.has(issueId)) {
            refusedUpdates.set(issueId, (refusedUpdates.get(issueId) ?? 0) + 1);
            throw unprocessable(
              "Blocked status requires an open blocker, a pending review or card, or a typed outside wait",
            );
          }
          return service.update(...updateArgs);
        },
      };
    },
  };
});

const { recoveryService } = await import("../services/recovery/service.js");
const { logger } = await import("../middleware/logger.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded reconcile refusal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stranded reconcile and the blocked-state integrity guard (SYNA-3599)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("stranded-reconcile-refusal-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_BLOCKED_STATE_INTEGRITY", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  // The live shape: an agent-assigned `todo` issue with no run whose assignee
  // is paused, so the sweep escalates it to the board as not invokable.
  async function seedTodoIssue(agentStatus: "paused" | "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stranded refusal fixture",
      issuePrefix: `R${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "fixture-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: agentStatus,
      adapterType: "codex_local",
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded todo",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: "fixture-owner",
    });
    return { companyId, agentId, issueId };
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  function logCallsFor(spy: { mock: { calls: unknown[][] } }, issueId: string) {
    return spy.mock.calls.filter((call) => (call[0] as { issueId?: string } | undefined)?.issueId === issueId);
  }

  it("escalates a not-invokable todo issue to blocked with a board wait that the guard accepts", async () => {
    const { issueId } = await seedTodoIssue("paused");
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const errors = vi.spyOn(logger, "error");

    const first = await recovery.reconcileStrandedAssignedIssues();

    expect(first.issueIds).toContain(issueId);
    expect(logCallsFor(errors, issueId)).toHaveLength(0);
    const escalated = await readIssue(issueId);
    expect(escalated.status).toBe("blocked");
    expect(escalated.unblockDescriptor).toMatchObject({ owner: "board", kind: "human" });
    expect(escalated.unblockDescriptor?.action).toMatch(/^The board chooses the next action/);

    // The blocked issue is no longer a sweep candidate, so the next tick writes nothing.
    const second = await recovery.reconcileStrandedAssignedIssues();
    expect(second.issueIds).not.toContain(issueId);
    expect((await readIssue(issueId)).updatedAt).toEqual(escalated.updatedAt);
  });

  it("still dispatches a normal stranded todo issue to its invokable assignee", async () => {
    const { agentId, issueId } = await seedTodoIssue("idle");
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() }) as never);

    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(issueId);
    const dispatches = enqueueWakeup.mock.calls.filter(
      (call) => (call as unknown[])[0] === agentId,
    ) as unknown as Array<[string, { reason?: string; payload?: { issueId?: string } }]>;
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]![1]).toMatchObject({ reason: "issue_assigned", payload: { issueId } });
    expect((await readIssue(issueId)).status).toBe("todo");
  });

  it("does not send a refused write again on every tick, and logs one warning per issue state", async () => {
    const { issueId } = await seedTodoIssue("paused");
    refusedIssueIds.add(issueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const warnings = vi.spyOn(logger, "warn");
    const errors = vi.spyOn(logger, "error");

    try {
      const first = await recovery.reconcileStrandedAssignedIssues();
      expect(first.failed).toBeGreaterThanOrEqual(1);
      expect(refusedUpdates.get(issueId)).toBe(1);

      await recovery.reconcileStrandedAssignedIssues();
      await recovery.reconcileStrandedAssignedIssues();
      expect(refusedUpdates.get(issueId)).toBe(1);

      const refusalWarnings = () =>
        logCallsFor(warnings, issueId).filter((call) => String(call[1]).includes("reconcile was refused"));
      expect(refusalWarnings()).toHaveLength(1);
      expect(logCallsFor(errors, issueId)).toHaveLength(0);

      // A change to the issue row lets the sweep try once more.
      await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, issueId));
      await recovery.reconcileStrandedAssignedIssues();
      expect(refusedUpdates.get(issueId)).toBe(2);
      expect(refusalWarnings()).toHaveLength(2);
    } finally {
      refusedIssueIds.delete(issueId);
    }
    expect((await readIssue(issueId)).status).toBe("todo");
  });
});
