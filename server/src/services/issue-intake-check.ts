import { and, eq } from "drizzle-orm";
import { activityLog, issueComments, issueLabels, issues, labels, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { NO_WAKE_COMMENT_MARKER } from "./issue-comment-wakeup.js";

// This fork rule applies only to the personal Guild company.
export const INTAKE_COMPANY_ID = "d057bef7-f0b9-48e4-bb19-2e41feee0e53";
export const INTAKE_SKIP_REASON = "issue.intake_missing_sections";
export const INTAKE_SECTIONS = ["Intent", "Acceptance", "Non-functional limits", "Out of scope"] as const;
export type IntakeMode = "off" | "dry_run" | "enforce";

/** Read the operator switch on each call. Unknown values disable the rule. */
export function issueIntakeMode(env: NodeJS.ProcessEnv = process.env): IntakeMode {
  const mode = env.PAPERCLIP_ISSUE_INTAKE_CHECK?.trim();
  return mode === "dry_run" || mode === "enforce" ? mode : "off";
}

/** Read section headings, not mentions or examples inside fenced code. */
export function missingIntakeSections(description: string | null | undefined): string[] {
  const found = new Set<string>();
  let fence: { marker: string; length: number } | null = null;
  for (const line of (description ?? "").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; continue; }
    const heading = /^ {0,3}##[ \t]+(.+?)[ \t]*$/.exec(line)?.[1].replace(/[ \t]+#+$/, "")
      ?? /^[ \t]*\*\*(.+?)\*\*(?:[ \t]*:?[ \t]*.*)?$/.exec(line)?.[1];
    if (heading) found.add(heading.replace(/^\*\*(.*?)\*\*$/, "$1").replace(/:$/, "").trim().toLowerCase());
  }
  return INTAKE_SECTIONS.filter((section) => !found.has(section.toLowerCase()));
}

export function intakeExempt(issue: { title: string; originKind: string }, labelNames: string[]): boolean {
  return labelNames.some((name) => name.toLowerCase() === "owner:local-session")
    || /^Review hold:/i.test(issue.title)
    || /^Review r\d+:/i.test(issue.title)
    || /^Gate /i.test(issue.title)
    || /\(bridge-owned, do not edit\)$/i.test(issue.title)
    || issue.originKind === "task_bridge";
}

export const intakeCommentKey = (issueId: string) => `issue-intake:v1:${issueId}`;

/** Return a refusal reason. The caller must stop pickup when the result is non-null. */
export async function issueIntakeCheck(
  db: Db,
  input: { companyId: string; issueId: string; source: string },
): Promise<string | null> {
  const mode = issueIntakeMode();
  if (mode === "off" || input.companyId !== INTAKE_COMPANY_ID) return null;
  return db.transaction(async (tx) => {
    // Checkout, admission, and dispatch share this fence. Read current data after the lock.
    const [issue] = await tx.select({ title: issues.title, description: issues.description, originKind: issues.originKind })
      .from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (!issue) return null;
    const names = await tx.select({ name: labels.name }).from(issueLabels)
      .innerJoin(labels, and(eq(labels.companyId, issueLabels.companyId), eq(labels.id, issueLabels.labelId)))
      .where(and(eq(issueLabels.companyId, input.companyId), eq(issueLabels.issueId, input.issueId)));
    if (intakeExempt(issue, names.map(({ name }) => name))) return null;
    const missingSections = missingIntakeSections(issue.description);
    if (!missingSections.length) return null;
    logger.info({ event: "issue.intake_check", ...input, mode, missingSections, refused: mode === "enforce" },
      "Issue intake sections are missing.");
    if (mode === "dry_run") return null;

    const key = intakeCommentKey(input.issueId);
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.clientRequestId, key), eq(issueComments.authorType, "system"),
    )).limit(1);
    if (!existing) {
      // Insert directly: no route wake, plugin publication, mention scan, or recency change.
      // The durable key and issue lock also prevent duplicates after restart or concurrent pickup.
      await tx.insert(issueComments).values({ companyId: input.companyId, issueId: input.issueId,
        authorType: "system", clientRequestId: key,
        body: `${NO_WAKE_COMMENT_MARKER} Intake check refused this pickup. Missing sections: ${missingSections.join(", ")}. `
          + "Add the missing sections to the issue description before the next pickup. "
          + "Use ## headings or bold section names." });
      await tx.insert(activityLog).values({ companyId: input.companyId, entityType: "issue", entityId: input.issueId,
        actorType: "system", actorId: "issue-intake", action: "issue.intake_refused",
        details: { source: input.source, missingSections, idempotencyKey: key } });
    }
    return INTAKE_SKIP_REASON;
  });
}
