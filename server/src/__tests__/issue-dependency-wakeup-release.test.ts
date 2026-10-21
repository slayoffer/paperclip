import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, issueRelations, issues } from "@paperclipai/db";
import { createDependencyResolvedWakeup } from "../routes/issue-dependency-wakeup.js";
import { releaseReadyDependencyWait } from "../services/issue-dependency-release.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("dependency release wakes from routes", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("dependency-route-release-");
    db = createDb(temp.connectionString);
  }, 90000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), blockerId = randomUUID(), dependentId = randomUUID();
    const blockedTransitionAt = new Date("2026-10-20T10:00:00.000Z");
    await db.insert(companies).values({ id: companyId, name: "Route release", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "done", assigneeAgentId: agentId },
      { id: dependentId, companyId, title: "Dependent", status: "blocked", assigneeAgentId: agentId, blockedTransitionAt },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    const input = { dependentIssueId: dependentId, resolvedBlockerIssueId: blockerId, blockerIssueIds: [blockerId],
      blockedTransitionAt, source: "issue.update", mutation: "blocker_completed" };
    const stateKey = buildIssueBlockersResolvedWakeStateKey(input);
    const wake = () => createDependencyResolvedWakeup(db, companyId, { actorType: "system", actorId: "test" }, input,
      () => releaseReadyDependencyWait(db, companyId, dependentId));
    const recordWake = (status: string, suffix: string) => db.insert(agentWakeupRequests).values({ companyId, agentId,
      status, source: "automation", reason: "issue_blockers_resolved", payload: { issueId: dependentId },
      idempotencyKey: stateKey + suffix });
    return { companyId, blockerId, dependentId, input, stateKey, wake, recordWake };
  }

  it("suppresses a completed release after a done blocker becomes cancelled", async () => {
    const f = await fixture();
    await f.recordWake("completed", "");
    expect((await f.wake())?.idempotencyKey).toBe(f.stateKey + ":release");
    await f.recordWake("completed", ":release");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.dependentId));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.blockerId));
    // The real release accepts an already active dependent. The route must suppress its delivered wake.
    expect(await releaseReadyDependencyWait(db, f.companyId, f.dependentId)).toBe(true);
    expect(await f.wake()).toBeNull();
    expect(await f.wake()).toBeNull();
  });

  it.each(["queued", "claimed", "deferred_issue_execution", "completed"])(
    "suppresses a %s release for the same blocked cycle", async status => {
      const f = await fixture();
      await f.recordWake(status, ":release");
      expect(await f.wake()).toBeNull();
    },
  );

  it("allows a later blocked cycle after an earlier completed release", async () => {
    const f = await fixture();
    await f.recordWake("completed", ":release");
    f.input.blockedTransitionAt = new Date("2026-10-20T11:00:00.000Z");
    await db.update(issues).set({ blockedTransitionAt: f.input.blockedTransitionAt }).where(eq(issues.id, f.dependentId));
    const wake = await f.wake();
    expect(wake?.idempotencyKey).toBe(buildIssueBlockersResolvedWakeStateKey(f.input));
    expect(wake?.idempotencyKey).not.toBe(f.stateKey + ":release");
  });

  it("keeps a failed release eligible for a retry", async () => {
    const f = await fixture();
    await f.recordWake("failed", ":release");
    expect(await f.wake()).not.toBeNull();
  });
});
