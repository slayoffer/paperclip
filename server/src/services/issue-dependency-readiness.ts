import { and, eq, inArray } from "drizzle-orm";
import { type Db, issues, issueRelations, workspaceOperations } from "@paperclipai/db";
import { createIssueDependencyReadiness } from "./issue-blocker-details.js";
import { blockerIsResolved } from "./blocked-state-integrity.js";
import { isPullQueueEnabled } from "./pull-queue-policy.js";

export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  /** Blockers whose status is `done` but whose execution workspace has not yet finalized. */
  pendingFinalizeBlockerIssueIds: string[];
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};

type BlockerReadinessRow = {
  issueId: string;
  blockerIssueId: string;
  blockerStatus: string;
  blockerExecutionWorkspaceId: string | null;
};

async function listPendingFinalizeBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerWorkspacePairs: Array<{
    blockerIssueId: string;
    executionWorkspaceId: string;
  }>,
): Promise<Set<string>> {
  const pending = new Set<string>();
  const blockerIssueIds = [
    ...new Set(blockerWorkspacePairs.map((pair) => pair.blockerIssueId)),
  ];
  const executionWorkspaceIds = [
    ...new Set(blockerWorkspacePairs.map((pair) => pair.executionWorkspaceId)),
  ];
  if (blockerIssueIds.length === 0 || executionWorkspaceIds.length === 0)
    return pending;
  const blockerWorkspaceKeys = new Set(
    blockerWorkspacePairs.map(
      (pair) => `${pair.blockerIssueId}:${pair.executionWorkspaceId}`,
    ),
  );

  const rows = await dbOrTx
    .select({
      issueId: workspaceOperations.issueId,
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(
          workspaceOperations.executionWorkspaceId,
          executionWorkspaceIds,
        ),
      ),
    );

  const latestAttributedByBlockerWorkspace = new Map<
    string,
    { phase: string; status: string; startedAt: Date }
  >();
  const latestUnattributedByWorkspace = new Map<
    string,
    { phase: string; status: string; startedAt: Date }
  >();
  const latestSuccessfulFinalizeByWorkspace = new Map<string, Date>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    if (row.phase === "workspace_finalize" && row.status === "succeeded") {
      const current = latestSuccessfulFinalizeByWorkspace.get(
        row.executionWorkspaceId,
      );
      if (!current || row.startedAt > current) {
        latestSuccessfulFinalizeByWorkspace.set(
          row.executionWorkspaceId,
          row.startedAt,
        );
      }
    }
    if (row.issueId) {
      const key = `${row.issueId}:${row.executionWorkspaceId}`;
      if (!blockerWorkspaceKeys.has(key)) continue;
      const current = latestAttributedByBlockerWorkspace.get(key);
      if (!current || row.startedAt > current.startedAt) {
        latestAttributedByBlockerWorkspace.set(key, {
          phase: row.phase,
          status: row.status,
          startedAt: row.startedAt,
        });
      }
      continue;
    }

    const current = latestUnattributedByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestUnattributedByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const pair of blockerWorkspacePairs) {
    const latest =
      latestAttributedByBlockerWorkspace.get(
        `${pair.blockerIssueId}:${pair.executionWorkspaceId}`,
      ) ?? latestUnattributedByWorkspace.get(pair.executionWorkspaceId);
    if (!latest) continue; // no ops recorded -> nothing to finalize for this blocker
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded")
      continue;
    const laterSuccessfulFinalize = latestSuccessfulFinalizeByWorkspace.get(
      pair.executionWorkspaceId,
    );
    if (laterSuccessfulFinalize && laterSuccessfulFinalize > latest.startedAt)
      continue;
    pending.add(pair.blockerIssueId);
  }

  return pending;
}


export async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  if (uniqueIssueIds.length === 0) return new Map<string, IssueDependencyReadiness>();

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.status,
      blockerExecutionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issues.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    );

  return computeDependencyReadinessMap(dbOrTx, companyId, uniqueIssueIds, blockerRows);
}

/** Evaluate proposed blocker links before the update stores them. */
export async function getRequestedBlockerDependencyReadiness(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  blockerIds: string[],
) {
  const blockers = blockerIds.length === 0 ? [] : await dbOrTx.select({
    blockerIssueId: issues.id,
    blockerStatus: issues.status,
    blockerExecutionWorkspaceId: issues.executionWorkspaceId,
  }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds)));
  const readiness = await computeDependencyReadinessMap(dbOrTx, companyId, [issueId],
    blockers.map(blocker => ({ ...blocker, issueId })));
  return readiness.get(issueId)!;
}

async function computeDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
  blockerRows: BlockerReadinessRow[],
) {
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of issueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }

  // Resolved blockers must pass the workspace-finalize barrier.
  const resolvedBlockerWorkspacePairs: Array<{
    blockerIssueId: string;
    executionWorkspaceId: string;
  }> = [];
  for (const row of blockerRows) {
    if (blockerIsResolved(row.blockerStatus) && row.blockerExecutionWorkspaceId) {
      resolvedBlockerWorkspacePairs.push({
        blockerIssueId: row.blockerIssueId,
        executionWorkspaceId: row.blockerExecutionWorkspaceId,
      });
    }
  }
  const pendingFinalizeBlockerIssueIds =
    await listPendingFinalizeBlockerIssueIds(
      dbOrTx,
      companyId,
      resolvedBlockerWorkspacePairs,
    );

  for (const row of blockerRows) {
    const current =
      readinessMap.get(row.issueId) ??
      createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // Either switch permits cancelled blockers to resolve dependents.
    if (
      !blockerIsResolved(row.blockerStatus) &&
      !(isPullQueueEnabled() && row.blockerStatus === "cancelled")
    ) {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    } else if (
      row.blockerExecutionWorkspaceId &&
      pendingFinalizeBlockerIssueIds.has(row.blockerIssueId)
    ) {
      // Workspace-finalize barrier: the blocker's most recent run on its
      // execution workspace hasn't recorded a successful workspace_finalize.
      // Treat the dependent as not-ready until sync-back lands (or the run
      // finalizes); a subsequent finalize wake will re-evaluate readiness.
      // `allBlockersDone` is cleared too so that callers using it as a
      // proxy for "this dependent can proceed" still see the gate.
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.pendingFinalizeBlockerIssueIds.push(row.blockerIssueId);
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}
