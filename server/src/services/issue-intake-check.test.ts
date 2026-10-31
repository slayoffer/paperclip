import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issueLabels, issues, labels } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { commentWakeSuppressed } from "./issue-comment-wakeup.js";
import { pullQueueCandidateBlocked, pullQueueFingerprint } from "./pull-queue-state.js";
import { INTAKE_COMPANY_ID, INTAKE_SECTIONS, INTAKE_SKIP_REASON, intakeCommentKey,
  issueIntakeCheck, issueIntakeMode, missingIntakeSections } from "./issue-intake-check.js";

const complete = INTAKE_SECTIONS.map((section) => `## ${section}\nA defined limit.`).join("\n\n");
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("intake parser and switch", () => {
  it("accepts all four headings", () => expect(missingIntakeSections(complete)).toEqual([]));
  it("names missing sections in P7 order", () => {
    expect(missingIntakeSections("## Acceptance\nA test.")).toEqual(["Intent", "Non-functional limits", "Out of scope"]);
    expect(missingIntakeSections(null)).toEqual(INTAKE_SECTIONS);
  });
  it("accepts mixed case and CRLF", () => {
    expect(missingIntakeSections(complete.toUpperCase().replaceAll("\n", "\r\n"))).toEqual([]);
  });
  it("accepts bold section names with colons and inline text", () => {
    expect(missingIntakeSections(INTAKE_SECTIONS.map((section) => `**${section}:** A defined limit.`).join("\n"))).toEqual([]);
    expect(missingIntakeSections(INTAKE_SECTIONS.map((section) => `**${section}**\nText`).join("\n"))).toEqual([]);
  });
  it("rejects prose mentions, partial names, and fenced examples", () => {
    expect(missingIntakeSections(`Intent, Acceptance, Non-functional limits, Out of scope\n## Intentions\n`
      + `\`\`\`markdown\n${complete}\n\`\`\`\n~~~\n${complete}\n~~~`)).toEqual(INTAKE_SECTIONS);
  });
  it("accepts closing hashes and bold names in level-two headings", () => {
    expect(missingIntakeSections(INTAKE_SECTIONS.map((section) => `## **${section}** ##`).join("\n"))).toEqual([]);
  });
  it.each([undefined, "", "off", "invalid", "true"])("defaults %s to off", (value) => {
    expect(issueIntakeMode({ PAPERCLIP_ISSUE_INTAKE_CHECK: value })).toBe("off");
  });
  it.each(["dry_run", "enforce"] as const)("reads %s", (value) => {
    expect(issueIntakeMode({ PAPERCLIP_ISSUE_INTAKE_CHECK: ` ${value} ` })).toBe(value);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;
databaseTests("intake pickup with PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let agentId: string;
  let issue: typeof issues.$inferSelect;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-intake-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: INTAKE_COMPANY_ID, name: "Guild", issuePrefix: "SYNA" });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: INTAKE_COMPANY_ID, name: "Intake owner",
      role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} });
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_INTAKE_CHECK", "enforce");
    [issue] = await db.insert(issues).values({ companyId: INTAKE_COMPANY_ID,
      title: "Work", status: "todo", description: "## Intent\nMake a change.", assigneeAgentId: agentId }).returning();
  });
  const check = (source = "test.pickup") => issueIntakeCheck(db, { companyId: INTAKE_COMPANY_ID, issueId: issue.id, source });
  const comments = () => db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));

  it("off performs no database work", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_INTAKE_CHECK", "off");
    const unused = { transaction: vi.fn(() => { throw new Error("Must not read the database"); }) };
    expect(await issueIntakeCheck(unused as unknown as typeof db,
      { companyId: INTAKE_COMPANY_ID, issueId: issue.id, source: "test" })).toBeNull();
    expect(unused.transaction).not.toHaveBeenCalled();
    expect(await comments()).toEqual([]);
  });
  it("dry_run logs structured missing sections and permits pickup without a comment", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_INTAKE_CHECK", "dry_run");
    const log = vi.spyOn(logger, "info");
    expect(await check()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "issue.intake_check", mode: "dry_run",
      issueId: issue.id, refused: false, missingSections: ["Acceptance", "Non-functional limits", "Out of scope"] }), expect.any(String));
    expect(await comments()).toEqual([]);
  });
  it("enforce refuses repeated and concurrent pickup with one durable no-wake comment", async () => {
    expect(await Promise.all([check("checkout"), check("admission"), check("dispatch")])).toEqual([
      INTAKE_SKIP_REASON, INTAKE_SKIP_REASON, INTAKE_SKIP_REASON,
    ]);
    expect(await check()).toBe(INTAKE_SKIP_REASON);
    const saved = await comments();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ authorType: "system", clientRequestId: intakeCommentKey(issue.id) });
    expect(saved[0].body).toContain("Acceptance, Non-functional limits, Out of scope");
    expect(commentWakeSuppressed(saved[0].body, { type: "board", source: "session" })).toBe(true);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current.updatedAt).toEqual(issue.updatedAt);
    expect(current.status).toBe("todo");
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, issue.id),
      eq(activityLog.action, "issue.intake_refused")))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, INTAKE_COMPANY_ID))).toEqual([]);
  });
  it("permits a corrected description without another comment", async () => {
    await check();
    await db.update(issues).set({ description: complete }).where(eq(issues.id, issue.id));
    expect(await check()).toBeNull();
    expect(await comments()).toHaveLength(1);
  });
  it.each(["Review hold: work", "Review r2: work", "Gate qa: work", "Work (bridge-owned, do not edit)"])("exempts %s", async (title) => {
    await db.update(issues).set({ title }).where(eq(issues.id, issue.id));
    expect(await check()).toBeNull();
    expect(await comments()).toEqual([]);
  });
  it("exempts task-bridge origins", async () => {
    await db.update(issues).set({ originKind: "task_bridge" }).where(eq(issues.id, issue.id));
    expect(await check()).toBeNull();
  });
  it("exempts board conversations without task sections", async () => {
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "board-user",
      conversationState: "active", description: null }).where(eq(issues.id, issue.id));
    expect(await check("heartbeat.admission")).toBeNull();
    expect(await comments()).toEqual([]);
  });
  it("exempts external chat-channel conversations", async () => {
    await db.update(issues).set({ originKind: "chat_channel", description: "Started from telegram: chat" })
      .where(eq(issues.id, issue.id));
    expect(await check("heartbeat.admission")).toBeNull();
    expect(await comments()).toEqual([]);
  });
  it("exempts current local-session labels but ignores labels from another company", async () => {
    const other = randomUUID();
    await db.insert(companies).values({ id: other, name: "Other", issuePrefix: `O${other.slice(0, 5)}` });
    const [foreign] = await db.insert(labels).values({ companyId: other, name: "owner:local-session", color: "#000000" }).returning();
    await db.insert(issueLabels).values({ companyId: INTAKE_COMPANY_ID, issueId: issue.id, labelId: foreign.id });
    expect(await check()).toBe(INTAKE_SKIP_REASON);
    const [local] = await db.insert(labels).values({ companyId: INTAKE_COMPANY_ID, name: "owner:local-session", color: "#000000" }).returning();
    await db.insert(issueLabels).values({ companyId: INTAKE_COMPANY_ID, issueId: issue.id, labelId: local.id });
    expect(await check()).toBeNull();
  });
  it("does not check another company", async () => {
    expect(await issueIntakeCheck(db, { companyId: randomUUID(), issueId: issue.id, source: "test" })).toBeNull();
    expect(await comments()).toEqual([]);
  });
  it("checkout returns 409 and preserves the comment outside the refusal", async () => {
    const { issueService } = await import("./issues.js");
    const svc = issueService(db);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(svc.checkout(issue.id, agentId, ["todo"], null)).rejects.toMatchObject({ status: 409 });
    }
    expect(await comments()).toHaveLength(1);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current).toMatchObject({ status: "todo", checkoutRunId: null, executionRunId: null });
  });
  it.each(["off", "dry_run"])("checkout permits missing sections in %s mode", async (mode) => {
    vi.stubEnv("PAPERCLIP_ISSUE_INTAKE_CHECK", mode);
    const { issueService } = await import("./issues.js");
    expect(await issueService(db).checkout(issue.id, agentId, ["todo"], null)).toMatchObject({ status: "in_progress" });
    expect(await comments()).toEqual([]);
  });
  it("checkout permits complete P7 sections in enforce mode", async () => {
    await db.update(issues).set({ description: complete }).where(eq(issues.id, issue.id));
    const { issueService } = await import("./issues.js");
    expect(await issueService(db).checkout(issue.id, agentId, ["todo"], null)).toMatchObject({ status: "in_progress" });
    expect(await comments()).toEqual([]);
  });
  it("cancels a previously queued run after the mode changes to enforce", async () => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: INTAKE_COMPANY_ID, agentId,
      invocationSource: "assignment", status: "queued", contextSnapshot: { issueId: issue.id } }).returning();
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(current).toMatchObject({ status: "cancelled", startedAt: null });
    expect(await comments()).toHaveLength(1);
    await heartbeat.resumeQueuedRuns();
    expect(await comments()).toHaveLength(1);
  }, 30_000);
  it("wake admission refuses before creating a run and does not wake from its comment", async () => {
    const { heartbeatService } = await import("./heartbeat.js");
    const heartbeat = heartbeatService(db);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned",
        requestedByActorType: "system", payload: { issueId: issue.id } })).toBeNull();
    }
    expect(await comments()).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.contextIssueId, issue.id))).toEqual([]);
  });
  it.each(["corrected description", "disabled enforcement"])("rechecks an intake skip after %s", async (correction) => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const fingerprint = await pullQueueFingerprint(db, issue, agent);
    const { heartbeatService } = await import("./heartbeat.js");
    expect(await heartbeatService(db).wakeup(agentId, { source: "assignment", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id, pullQueueFingerprint: fingerprint } })).toBeNull();
    expect(await pullQueueCandidateBlocked(db, issue, agent, fingerprint)).toBe(false);
    expect(await check("heartbeat.admission")).toBe(INTAKE_SKIP_REASON);
    if (correction === "corrected description") {
      await db.update(issues).set({ description: complete }).where(eq(issues.id, issue.id));
    } else {
      vi.stubEnv("PAPERCLIP_ISSUE_INTAKE_CHECK", "off");
    }
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(await pullQueueFingerprint(db, current, agent)).toBe(fingerprint);
    expect(await pullQueueCandidateBlocked(db, current, agent, fingerprint)).toBe(false);
    expect(await comments()).toHaveLength(1);
  });
});
