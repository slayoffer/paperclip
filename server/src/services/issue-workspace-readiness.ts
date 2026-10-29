import { and, eq, inArray } from "drizzle-orm";
import { workspaceOperations, type Db } from "@paperclipai/db";

/**
 * Returns the set of execution-workspace ids whose most recent workspace operation
 * is NOT a successful `workspace_finalize`. These workspaces have either an in-flight
 * run, a failed finalize, or never reached the finalize barrier — dependents that
 * read this workspace must wait until finalize succeeds.
 *
 * Workspaces with no recorded operations are considered finalized (nothing has
 * touched them since they were realized).
 */
export async function listUnfinalizedExecutionWorkspaceIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceIds: string[],
): Promise<Set<string>> {
  const unfinalized = new Set<string>();
  if (executionWorkspaceIds.length === 0) return unfinalized;

  // Pull every workspace op for the candidate workspaces and pick the latest per
  // workspace in memory. Per-workspace LATERAL queries would be tighter, but the
  // candidate set is tiny in practice (one workspace per blocker per readiness call).
  const rows = await dbOrTx
    .select({
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

  const latestByWorkspace = new Map<
    string,
    { phase: string; status: string; startedAt: Date }
  >();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    const current = latestByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const workspaceId of executionWorkspaceIds) {
    const latest = latestByWorkspace.get(workspaceId);
    if (!latest) continue; // no ops recorded → treat as finalized
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded")
      continue;
    unfinalized.add(workspaceId);
  }

  return unfinalized;
}
