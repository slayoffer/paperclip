import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

/** Parse one handoff block with exactly four unique fields in any order. */
export function parseReviewHandoffManifest(body: string) {
  const blocks = [...body.matchAll(/^```handoff[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (blocks.length !== 1) return null;
  const fields = blocks[0][1].trim().split(/\r?\n/);
  if (fields.length !== 4) return null;
  const manifest = new Map<string, string>();
  for (const line of fields) {
    const field = /^(repo|base|head|branch):[ \t]+(\S+)[ \t]*$/.exec(line);
    if (!field || manifest.has(field[1])) return null;
    manifest.set(field[1], field[2]);
  }
  const repo = manifest.get("repo")!;
  const base = manifest.get("base")!.toLowerCase();
  const head = manifest.get("head")!.toLowerCase();
  const branch = manifest.get("branch")!;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) return null;
  return { repo, base, head, branch };
}

/** Permit only a board-owned review wait for the latest saved owner handoff. */
export async function hasSavedReviewWait(
  db: Pick<Db, "select">,
  issue: { id: string; companyId: string; identifier: string | null; assigneeAgentId: string | null },
  actorAgentId: string | undefined,
  descriptor: IssueUnblockDescriptor,
): Promise<boolean> {
  if (!actorAgentId || issue.assigneeAgentId !== actorAgentId || descriptor.owner !== "board") return false;
  const head = /^waiting for the cross-vendor review of ([a-f0-9]{40})$/i.exec(descriptor.action)?.[1];
  if (!head || !issue.identifier) return false;

  // Read persisted comments only. A comment in the same PATCH is not saved evidence.
  const [handoff] = await db.select({ body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, issue.companyId),
      eq(issueComments.issueId, issue.id),
      eq(issueComments.authorAgentId, actorAgentId),
      isNull(issueComments.deletedAt),
      sql`${issueComments.body} ~ ${"(^|\n)```handoff[ \\t]*\\r?\n"}`,
    ))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1);
  if (!handoff) return false;
  const manifest = parseReviewHandoffManifest(handoff.body);
  return manifest !== null && manifest.head === head.toLowerCase()
    && manifest.branch === `review/${issue.identifier}`;
}
