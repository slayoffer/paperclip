import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { resolveSuppressedDependencyRecoveries } from "../dependency-recovery-resolution.js";
import { releaseReadyDependencyWait } from "../issue-dependency-release.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeStateKey,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "../issue-dependency-wakeups.js";
import { issueService } from "../issues.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { queryResolvedDependencyCandidates, RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT } from "./resolved-dependency-candidates.js";
import type { RecoveryWakeup } from "./service.js";

type ResolvedDependencyWakeBackstopSource =
  "issue_graph_liveness.backstop" | "workspace.finalize";

type ResolvedDependencyWakeBackstopOptions = {
  runId?: string | null;
  companyId?: string | null;
  blockerIssueId?: string | null;
  source?: ResolvedDependencyWakeBackstopSource;
};

export function createResolvedDependencyWakeBackstop(db: Db, deps: {
  enqueueWakeup: RecoveryWakeup;
  hasActiveExecutionPath: (companyId: string, issueId: string, agentId?: string | null) => Promise<boolean>;
  hasQueuedIssueWake: (companyId: string, issueId: string, agentId?: string | null) => Promise<boolean>;
  hasPendingWakeInteraction: (companyId: string, issueId: string) => Promise<boolean>;
}) {
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);
  const { hasActiveExecutionPath, hasQueuedIssueWake, hasPendingWakeInteraction } = deps;
  let resolvedDependencyWakeBackstopCandidateCursor: string | null = null;

  async function reconcileResolvedDependencyWakeBackstop(
    opts?: ResolvedDependencyWakeBackstopOptions,
  ) {
    const result = {
      checked: 0,
      healed: 0,
      existingWakeSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      notReadySkipped: 0,
      candidateLimitSkipped: 0,
      deferredOrFailed: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
    };

    const source = opts?.source ?? "issue_graph_liveness.backstop";
    const requestedByActorId =
      source === "workspace.finalize"
        ? "heartbeat_finalize"
        : "issue_graph_liveness_backstop";
    const payloadBackstop =
      source === "workspace.finalize"
        ? "workspace_finalize_reconciliation"
        : "issue_graph_liveness_reconciliation";
    const useCursor = !opts?.blockerIssueId;

    const queryCandidates = (afterIssueId: string | null) =>
      queryResolvedDependencyCandidates(db, opts, afterIssueId);

    let candidateRows = await queryCandidates(
      useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null,
    );
    if (
      useCursor &&
      candidateRows.length === 0 &&
      resolvedDependencyWakeBackstopCandidateCursor
    ) {
      resolvedDependencyWakeBackstopCandidateCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(
      ({ totalCount: _totalCount, ...candidate }) => candidate,
    );
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(
      0,
      totalCandidateCount - candidates.length,
    );
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    if (useCursor) {
      resolvedDependencyWakeBackstopCandidateCursor =
        result.candidateLimitSkipped > 0 && lastCandidate
          ? lastCandidate.id
          : null;
    }
    if (result.candidateLimitSkipped > 0) {
      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT,
          nextCursor: useCursor
            ? resolvedDependencyWakeBackstopCandidateCursor
            : null,
          source,
          blockerIssueId: opts?.blockerIssueId ?? null,
        },
        "issue graph liveness backstop deferred resolved dependency wake candidates past page limit",
      );
    }

    const candidatesByCompany = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const companyCandidates =
        candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    for (const [
      companyId,
      companyCandidates,
    ] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const agentId = candidate.assigneeAgentId;
        if (!agentId) continue;

        // Settlement needs dispatch proof, not a current dependency relation.
        await resolveSuppressedDependencyRecoveries(db, companyId, candidate.id);
        const readiness = readinessMap.get(candidate.id);
        const resolvedBlockerIssueId = readiness?.blockerIssueIds[0] ?? null;
        if (
          !readiness ||
          !readiness.isDependencyReady ||
          readiness.blockerIssueIds.length === 0 ||
          !resolvedBlockerIssueId
        ) {
          result.notReadySkipped += 1;
          continue;
        }

        // Reuse the dependency state key across release paths.
        const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: candidate.id,
          blockerIssueIds: readiness.blockerIssueIds,
          blockedTransitionAt: candidate.blockedTransitionAt,
        }) + ":release";
        if (!(await releaseReadyDependencyWait(db, companyId, candidate.id))) {
          result.notReadySkipped += 1;
          continue;
        }
        const existingWake =
          await findExistingIssueBlockersResolvedWakeForReadyState(db, {
            companyId,
            dependentIssueId: candidate.id,
            blockerIssueIds: readiness.blockerIssueIds,
            blockedTransitionAt: candidate.blockedTransitionAt,
          });
        if (existingWake && (existingWake.status !== "completed" || existingWake.idempotencyKey?.endsWith(":release"))) {
          result.existingWakeSkipped += 1;
          continue;
        }

        if (
          (await hasActiveExecutionPath(companyId, candidate.id, agentId)) ||
          (await hasQueuedIssueWake(companyId, candidate.id, agentId))
        ) {
          result.livePathSkipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped += 1;
          continue;
        }

        if (
          await isAutomaticRecoverySuppressedByPauseHold(
            db,
            companyId,
            candidate.id,
            treeControlSvc,
          )
        ) {
          result.pauseHoldSkipped += 1;
          continue;
        }

        try {
          const wake = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            payload: {
              issueId: candidate.id,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
              backstop: payloadBackstop,
            },
            idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId,
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              source,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
          if (!wake) {
            // enqueueWakeup returns null for normal deferred/skipped paths
            // such as disabled wake-on-demand or concurrency gating. That is
            // not an enqueue error, but the backstop still did not heal now.
            result.deferredOrFailed += 1;
            continue;
          }

          result.healed += 1;
          result.issueIds.push(candidate.id);

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "issue_graph_liveness_backstop",
            agentId,
            runId: opts?.runId ?? null,
            action: "issue.blockers_resolved_wake_emitted",
            entityType: "issue",
            entityId: candidate.id,
            details: {
              source,
              dependencyReleaseStatusVersion: candidate.releaseStatusVersion,
              wakeupRunId: wake.id,
              idempotencyKey,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
        } catch (err) {
          result.deferredOrFailed += 1;
          result.enqueueFailed += 1;
          logger.warn(
            { err, issueId: candidate.id, agentId, idempotencyKey, source },
            "failed to enqueue dependency wake from issue graph liveness backstop",
          );
        }
      }
    }

    if (result.healed > 0) {
      logger.warn(
        {
          healed: result.healed,
          issueIds: result.issueIds,
          source,
          blockerIssueId: opts?.blockerIssueId ?? null,
        },
        "issue graph liveness backstop healed resolved blocked dependency wakes",
      );
    }

    return result;
  }

  return reconcileResolvedDependencyWakeBackstop;
}
