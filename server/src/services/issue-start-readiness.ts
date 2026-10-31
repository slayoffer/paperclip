import type { Db } from "@paperclipai/db";
import { conflict, unprocessable } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { issueIntakeCheck } from "./issue-intake-check.js";
import { preserveBridgeHolds } from "./blocked-dependency-release.js";
import { listUnresolvedBlockerDetails } from "./issue-blocker-details.js";
import { getRequestedBlockerDependencyReadiness, listIssueDependencyReadinessMap } from "./issue-dependency-readiness.js";

export async function assertCheckoutReady(db: Db, companyId: string, issueId: string, agentId: string) {
  await assertAssignableAgent(db, companyId, agentId, { kind: "work" });
  if (await issueIntakeCheck(db, { companyId, issueId, source: "issue.checkout" })) {
    throw conflict("Issue intake check refused pickup. Add the missing sections named in the issue comment.", {
      code: "issue.intake_missing_sections", issueId,
    });
  }
}

/**
 * Reject an `in_progress` write while an effective blocker is unresolved.
 * Requested links replace the saved links, but the blocker sync keeps each open bridge hold.
 * Thus the check uses the requested links plus the preserved holds, not only the request.
 * Without requested links, the check uses the saved links.
 */
export async function assertIssueReadyToStart(
  db: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  requestedBlockerIds?: string[],
) {
  const readiness = requestedBlockerIds === undefined
    ? (await listIssueDependencyReadinessMap(db, companyId, [issueId])).get(issueId)
    : await getRequestedBlockerDependencyReadiness(db, companyId, issueId,
      await preserveBridgeHolds(db, companyId, issueId, requestedBlockerIds));
  const unresolvedBlockerIssueIds = readiness?.unresolvedBlockerIssueIds ?? [];
  if (unresolvedBlockerIssueIds.length === 0) return;
  const unresolvedBlockers = await listUnresolvedBlockerDetails(
    db, companyId, unresolvedBlockerIssueIds, readiness?.pendingFinalizeBlockerIssueIds,
  );
  throw unprocessable("Issue is blocked by unresolved blockers", {
    unresolvedBlockerIssueIds,
    unresolvedBlockers,
  });
}
