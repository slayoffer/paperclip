import type { IssueBlockerAttention } from "@paperclipai/shared";
import type { IssueDependencyReadiness } from "./issues.js";
import { blockedStateIntegrityEnabled } from "./blocked-state-integrity.js";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

export async function listUnresolvedBlockerDetails(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  unresolvedBlockerIssueIds: string[],
  pendingFinalizeBlockerIssueIds: string[] = [],
) {
  if (unresolvedBlockerIssueIds.length === 0) return [];
  const pendingFinalizeIds = new Set(pendingFinalizeBlockerIssueIds);
  const rows = await dbOrTx
    .select({
      issueId: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, unresolvedBlockerIssueIds),
      ),
    );
  const rowsById = new Map(rows.map((row) => [row.issueId, row]));
  return unresolvedBlockerIssueIds.map((issueId) => {
    const row = rowsById.get(issueId);
    return {
      issueId,
      identifier: row?.identifier ?? null,
      title: row?.title ?? null,
      reason: pendingFinalizeIds.has(issueId)
        ? ("pending_finalize" as const)
        : ("not_done" as const),
    };
  });
}


export async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        notInArray(issues.status, blockedStateIntegrityEnabled() ? ["done", "cancelled"] : ["done"]),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}

export function createIssueDependencyReadiness(
  issueId: string,
): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

export function createIssueBlockerAttention(
  input: Partial<IssueBlockerAttention> = {},
): IssueBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    pendingFinalizeBlockerIssueIds: input.pendingFinalizeBlockerIssueIds ?? [],
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier:
      input.sampleStalledBlockerIdentifier ?? null,
    blockingTreeLive: input.blockingTreeLive ?? false,
    directBlockerIssueId: input.directBlockerIssueId ?? null,
    terminalBlockerIssueId: input.terminalBlockerIssueId ?? null,
    terminalBlocker: input.terminalBlocker ?? null,
  };
}
