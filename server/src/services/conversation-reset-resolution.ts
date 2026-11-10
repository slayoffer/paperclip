import { and, eq } from "drizzle-orm";
import { issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";

/** Run inside the reset transaction. Only the saved command supplies provenance. */
export function expireConversationQuestions(
  db: Db,
  issue: { id: string; companyId: string },
  comment: typeof issueComments.$inferSelect,
) {
  return db.update(issueThreadInteractions).set({
    status: "expired", resolvedAt: new Date(), updatedAt: new Date(),
    resolvedByUserId: comment.authorUserId,
    resolvedVia: comment.authorAuthSource ?? null,
    result: { version: 1, outcome: "withdrawn", reason: "New conversation session", answers: [], summaryMarkdown: null },
  }).where(and(eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.status, "pending"),
    eq(issueThreadInteractions.kind, "ask_user_questions"))).returning({ id: issueThreadInteractions.id });
}
