import type { Request, Response } from "express";
import type { IssueDependencyReadiness } from "../services/issues.js";

type ResumeIssue = {
  id: string;
  companyId: string;
  status: string;
  projectId: string | null;
  parentId: string | null;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
};

export function createExplicitResumeIntentGuard<TIssue extends ResumeIssue, TDecision>({
  assertLowTrustControlPlaneDenied,
  isExplicitResumeCapableStatus,
  getActivePauseHoldGate,
  getDependencyReadiness,
  hasActiveCheckoutManagementOverride,
  decideIssueAccess,
  isDefaultOpenIssueWriteDecision,
}: {
  assertLowTrustControlPlaneDenied: (req: Request, res: Response, companyId: string, issue: TIssue) => Promise<boolean>;
  isExplicitResumeCapableStatus: (status: string) => boolean;
  getActivePauseHoldGate: (companyId: string, issueId: string) => Promise<{
    holdId: string;
    rootIssueId: string;
    mode: string;
  } | null>;
  getDependencyReadiness: (issueId: string, blockerIssueIds?: string[]) => Promise<IssueDependencyReadiness>;
  hasActiveCheckoutManagementOverride: (agentId: string, companyId: string, assigneeAgentId: string) => Promise<boolean>;
  decideIssueAccess: (req: Request, issue: TIssue, action: "issue:mutate") => Promise<TDecision>;
  isDefaultOpenIssueWriteDecision: (decision: TDecision) => boolean;
}) {
  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    issue: TIssue,
    options: { resumeIntent?: boolean; blockedByIssueIds?: string[] } = {},
  ) {
    if (
      await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)
    )
      return false;

    // Structured resume intent is the sole comment surface that may revive a
    // cancelled issue. Bare status transitions and `reopen` keep using the
    // dedicated restore-flow guard.
    if (issue.status === "cancelled" && options.resumeIntent !== true) {
      res.status(409).json({
        error:
          "Cancelled issues must be restored through the dedicated restore flow",
        details: {
          issueId: issue.id,
          status: issue.status,
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(issue.status)) {
      res.status(409).json({
        error: "Issue is not resumable through comment follow-up intent",
        details: { issueId: issue.id, status: issue.status },
      });
      return false;
    }

    const activePauseHold = await getActivePauseHoldGate(
      issue.companyId,
      issue.id,
    );
    if (activePauseHold) {
      res.status(409).json({
        error: "Issue follow-up blocked by active subtree pause hold",
        details: {
          issueId: issue.id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
        },
      });
      return false;
    }

    if (issue.status === "blocked") {
      const readiness = await getDependencyReadiness(issue.id, options.blockedByIssueIds);
      if (readiness.unresolvedBlockerCount > 0) {
        res.status(409).json({
          error: "Issue follow-up blocked by unresolved blockers",
          details: {
            issueId: issue.id,
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
          },
        });
        return false;
      }
    }

    if (req.actor.type !== "agent") return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (!issue.assigneeAgentId) {
      res.status(409).json({
        error: "Issue follow-up requires an assigned agent",
        details: { issueId: issue.id, actorAgentId },
      });
      return false;
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (
      await hasActiveCheckoutManagementOverride(
        actorAgentId,
        issue.companyId,
        issue.assigneeAgentId,
      )
    ) {
      return true;
    }
    const boundaryDecision = await decideIssueAccess(
      req,
      issue,
      "issue:mutate",
    );
    if (isDefaultOpenIssueWriteDecision(boundaryDecision)) return true;

    res.status(403).json({
      error: "Agent cannot request follow-up for another agent's issue",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
      },
    });
    return false;
  }

  return assertExplicitResumeIntentAllowed;
}
