import type { Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import type { getActorInfo } from "../routes/authz.js";

type WakeIssue = { id: string; assigneeAgentId: string | null; status: string; assigneeUserId?: string | null; workMode?: string | null };
export type ResolutionRouteIssue = WakeIssue & { companyId: string; identifier?: string | null };
export type ResolutionContinuationInput = {
  db: Db; heartbeat: IssueAssignmentWakeupDeps;
  issue: WakeIssue & { companyId: string };
  interaction: IssueThreadInteraction;
  actor: ReturnType<typeof getActorInfo>;
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
};

/** Shared by transactional revision answers and compatibility callers. */
export async function persistInteractionResolutionRouteEffects(input: {
  db: Db; heartbeat: IssueAssignmentWakeupDeps;
  issue: ResolutionRouteIssue;
  interaction: IssueThreadInteraction;
  actor: ReturnType<typeof getActorInfo>;
  operation: "accept" | "reject" | "respond";
  resolverAuthorizationReason: string;
  queueContinuation: (input: ResolutionContinuationInput) => Promise<void>;
  publications?: ActivityPublication[];
  createdIssues?: WakeIssue[];
  continuationIssue?: WakeIssue | null;
  acceptedPlanConfirmation?: boolean;
}) {
  const { db, heartbeat, issue, interaction, actor, operation, resolverAuthorizationReason,
    queueContinuation, publications, continuationIssue, acceptedPlanConfirmation } = input;
  const createdIssues = input.createdIssues ?? [];
  if (operation === "accept") {
    const continuationWakeIssue = continuationIssue ?? issue;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action:
        interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        resolutionActorKind: actor.actorType,
        requestedResolverPolicy: interaction.requestedResolverPolicy,
        effectiveResolverPolicy: interaction.effectiveResolverPolicy,
        resolverPolicyProvenance: interaction.resolverPolicyProvenance,
        effectiveResolverPolicySource:
          interaction.effectiveResolverPolicySource,
        resolverAuthorizationReason: resolverAuthorizationReason,
        createdTaskCount:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.createdTasks?.length ?? 0)
            : 0,
        skippedTaskCount:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.skippedClientKeys?.length ?? 0)
            : 0,
      },
    }, publications);

    if (continuationIssue) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          status: continuationIssue.status,
          ...(continuationIssue.workMode
            ? { workMode: continuationIssue.workMode }
            : {}),
          assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
          assigneeUserId: continuationIssue.assigneeUserId ?? null,
          source: "request_confirmation_accept",
          interactionId: interaction.id,
          _previous: {
            status: issue.status,
            workMode: issue.workMode,
            assigneeAgentId: issue.assigneeAgentId ?? null,
            assigneeUserId: issue.assigneeUserId ?? null,
          },
        },
      }, publications);
    }

    for (const createdIssue of createdIssues) {
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: createdIssue,
        reason: "issue_assigned",
        mutation: "interaction_accept",
        contextSource: "issue.interaction.accept",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }

    await queueContinuation({
      db,
      heartbeat,
      issue: { ...continuationWakeIssue, companyId: issue.companyId },
      interaction: interaction,
      actor,
      source: "issue.interaction.accept",
      forceFreshSession: acceptedPlanConfirmation,
      workspaceRefreshReason: acceptedPlanConfirmation
        ? "accepted_plan_confirmation"
        : null,
    });
  } else if (operation === "reject") {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action:
        interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        resolutionActorKind: actor.actorType,
        requestedResolverPolicy: interaction.requestedResolverPolicy,
        effectiveResolverPolicy: interaction.effectiveResolverPolicy,
        resolverPolicyProvenance: interaction.resolverPolicyProvenance,
        effectiveResolverPolicySource:
          interaction.effectiveResolverPolicySource,
        resolverAuthorizationReason: resolverAuthorizationReason,
        rejectionReason:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.rejectionReason ?? null)
            : interaction.kind === "request_confirmation" ||
                interaction.kind === "request_checkbox_confirmation"
              ? (interaction.result?.reason ?? null)
              : null,
      },
    }, publications);

    await queueContinuation({
      db,
      heartbeat,
      issue,
      interaction,
      actor,
      source: "issue.interaction.reject",
    });
  } else {
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.thread_interaction_answered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        resolutionActorKind: actor.actorType,
        requestedResolverPolicy: interaction.requestedResolverPolicy,
        effectiveResolverPolicy: interaction.effectiveResolverPolicy,
        resolverPolicyProvenance: interaction.resolverPolicyProvenance,
        effectiveResolverPolicySource:
          interaction.effectiveResolverPolicySource,
        resolverAuthorizationReason: resolverAuthorizationReason,
        answeredQuestionCount:
          interaction.kind === "ask_user_questions"
            ? (interaction.result?.answers?.length ?? 0)
            : 0,
      },
    }, publications);
  }
}
