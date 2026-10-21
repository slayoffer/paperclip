import { notFound } from "../errors.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, heartbeatRuns, issues, issueRelations, workspaceOperations } from "@paperclipai/db";
import { createIssueDependencyReadiness } from "./issue-blocker-details.js";
import { blockerIsResolved } from "./blocked-state-integrity.js";
import { isWorkspaceFinalizationOperationActive } from "./workspace-finalization-activity.js";

import type { IssueDependencyReadiness } from "@paperclipai/shared/types/issue-dependency-readiness";
export type { IssueDependencyReadiness } from "@paperclipai/shared/types/issue-dependency-readiness";
export { createIssueDependencyReadiness } from "./issue-blocker-details.js";

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
      id: workspaceOperations.id,
      heartbeatRunId: workspaceOperations.heartbeatRunId,
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
    { id: string; heartbeatRunId: string | null; phase: string; status: string; startedAt: Date }
  >();
  const latestUnattributedByWorkspace = new Map<
    string,
    { id: string; heartbeatRunId: string | null; phase: string; status: string; startedAt: Date }
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
          id: row.id, heartbeatRunId: row.heartbeatRunId,
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
        id: row.id, heartbeatRunId: row.heartbeatRunId,
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  // A later suppressed retry does not own an earlier workspace operation.
  const runIds = [...new Set(rows.flatMap(row => row.heartbeatRunId ? [row.heartbeatRunId] : []))];
  const runs = runIds.length ? await dbOrTx.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    issueId: sql<string>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds))) : [];
  const runsById = new Map(runs.map(run => [run.id, run]));

  for (const pair of blockerWorkspacePairs) {
    const latest =
      latestAttributedByBlockerWorkspace.get(
        `${pair.blockerIssueId}:${pair.executionWorkspaceId}`,
      ) ?? latestUnattributedByWorkspace.get(pair.executionWorkspaceId);
    if (!latest) continue; // no ops recorded -> nothing to finalize for this blocker
    const relevantRows = rows.filter(row => row.executionWorkspaceId === pair.executionWorkspaceId
      && (!row.issueId || row.issueId === pair.blockerIssueId));
    const liveWork = relevantRows.some(row => {
      if (!row.heartbeatRunId) return false;
      if (row.phase === "workspace_finalize" && isWorkspaceFinalizationOperationActive({
        operationId: row.id, companyId, runId: row.heartbeatRunId, issueId: pair.blockerIssueId,
      })) return true;
      const owner = runsById.get(row.heartbeatRunId);
      return owner && ["queued", "running", "scheduled_retry"].includes(owner.status)
        && !relevantRows.some(finalize => finalize.heartbeatRunId === row.heartbeatRunId
          && finalize.phase === "workspace_finalize" && finalize.status === "succeeded"
          && finalize.startedAt >= row.startedAt);
    });
    if (liveWork) {
      pending.add(pair.blockerIssueId);
      continue;
    }
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    const laterSuccessfulFinalize = latestSuccessfulFinalizeByWorkspace.get(pair.executionWorkspaceId);
    if (laterSuccessfulFinalize && laterSuccessfulFinalize > latest.startedAt) continue;
    const owner = latest.heartbeatRunId ? runsById.get(latest.heartbeatRunId) : null;
    if (owner?.issueId === pair.blockerIssueId
      && ["failed", "cancelled", "timed_out", "interrupted"].includes(owner.status)) continue;
    pending.add(pair.blockerIssueId);
  }

  return pending;
}


export async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
  requestedBlockers?: { issueId: string; blockerIssueIds: string[] },
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  if (uniqueIssueIds.length === 0) return new Map<string, IssueDependencyReadiness>();

  // Preview the proposed relation without changing the stored graph.
  const blockerRows = requestedBlockers
    ? (await dbOrTx
        .select({
          blockerIssueId: issues.id,
          blockerStatus: issues.status,
          blockerExecutionWorkspaceId: issues.executionWorkspaceId,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, [...new Set(requestedBlockers.blockerIssueIds)]),
        )))
        .map((row) => ({ ...row, issueId: requestedBlockers.issueId }))
    : await dbOrTx
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
    // Cancellation voids the dependency.
    if (row.blockerStatus !== "done" && row.blockerStatus !== "cancelled") {
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
    current.unresolvedBlockerIds = current.unresolvedBlockerIssueIds;
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

export async function readIssueDependencyReadiness(
  dbOrTx: any,
  issueId: string,
  blockerIssueIds?: string[],
): Promise<IssueDependencyReadiness> {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const readiness = await listIssueDependencyReadinessMap(
    dbOrTx,
    issue.companyId,
    [issueId],
    blockerIssueIds === undefined ? undefined : { issueId, blockerIssueIds },
  );
  return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
}
