import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  buildExecutionContinuation,
  selectRecentCommentWindow,
  wakeRecentCommentLimit,
} from "./execution-continuation.js";

describe("recent-comment window helpers", () => {
  it("reads only a positive integer limit", () => {
    expect(wakeRecentCommentLimit({})).toBeNull();
    expect(wakeRecentCommentLimit({ PAPERCLIP_WAKE_RECENT_COMMENTS: "3" })).toBe(3);
    expect(wakeRecentCommentLimit({ PAPERCLIP_WAKE_RECENT_COMMENTS: " 5 " })).toBe(5);
    expect(wakeRecentCommentLimit({ PAPERCLIP_WAKE_RECENT_COMMENTS: "0" })).toBeNull();
    expect(wakeRecentCommentLimit({ PAPERCLIP_WAKE_RECENT_COMMENTS: "-2" })).toBeNull();
    expect(wakeRecentCommentLimit({ PAPERCLIP_WAKE_RECENT_COMMENTS: "three" })).toBeNull();
  });

  it("keeps the last N plus must-keep ids, in order, and counts the rest", () => {
    const messages = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const { kept, omittedCount } = selectRecentCommentWindow(messages, 3, ["b"]);
    expect(kept.map((m) => m.id)).toEqual(["b", "d", "e", "f"]);
    expect(omittedCount).toBe(2);
  });

  it("omits nothing when the history is short", () => {
    const messages = [{ id: "a" }, { id: "b" }];
    expect(selectRecentCommentWindow(messages, 3, [])).toEqual({ kept: messages, omittedCount: 0 });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("recent-comment window in the continuation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), documentId = randomUUID();
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const saved = process.env.PAPERCLIP_WAKE_RECENT_COMMENTS;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-continuation-window-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Window", issuePrefix: "WIN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Long thread", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueComments).values(ids.map((id, index): typeof issueComments.$inferInsert => ({
      id,
      companyId,
      issueId,
      ...(index === 0
        ? { authorType: "user", authorUserId: "local-board", body: "Ship the release notes." }
        : { authorType: "agent", authorAgentId: agentId, body: `status update ${index}` }),
      createdAt: new Date(Date.UTC(2026, 9, 17, 0, index)),
    })));
    await db.insert(documents).values({ id: documentId, companyId, title: "Plan", latestBody: "1. draft\n2. review\n3. publish" });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan" });
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_WAKE_RECENT_COMMENTS;
    else process.env.PAPERCLIP_WAKE_RECENT_COMMENTS = saved;
  });
  const build = () => buildExecutionContinuation({
    db, companyId, issueId, agentId,
    context: { wakeReason: "issue_commented", commentId: ids[7] },
    summary: null,
    exposeLowTrustRaw: false,
  });

  it("sends the full history when the window is off", async () => {
    delete process.env.PAPERCLIP_WAKE_RECENT_COMMENTS;
    const envelope = await build();
    expect(envelope.messages).toHaveLength(8);
    expect(envelope.omittedMessages).toBeUndefined();
    expect(envelope.planDocument).toBeUndefined();
    expect(envelope.coverage.kind).toBe("full_task_history");
  });

  it("sends the last 3 comments, the latest human request, the plan and the omitted count", async () => {
    process.env.PAPERCLIP_WAKE_RECENT_COMMENTS = "3";
    const envelope = await build();
    expect(envelope.messages.map((m) => m.id)).toEqual([ids[0], ids[5], ids[6], ids[7]]);
    expect(envelope.objective).toBe("Ship the release notes.");
    expect(envelope.objectiveSource).toMatchObject({ kind: "comment", id: ids[0] });
    expect(envelope.omittedMessages).toEqual({ count: 4, readVia: `GET /api/issues/${issueId}/comments` });
    expect(envelope.planDocument).toMatchObject({ key: "plan", title: "Plan", revision: 1, truncated: false });
    expect(envelope.coverage.kind).toBe("recent_window");

    const prompt = renderPaperclipWakePrompt({ executionContinuation: envelope }, { resumedSession: false });
    const [request, evidence] = prompt.split("### Untrusted continuation evidence");
    expect(request).toContain("4 older comments omitted");
    expect(request).not.toContain("History is complete");
    expect(request).not.toContain("2. review");
    expect(evidence).toContain("2. review");
  });
});
