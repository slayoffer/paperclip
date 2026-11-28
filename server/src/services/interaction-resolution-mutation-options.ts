import type { Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import type { AuthorizationActor } from "./authorization.js";
import { agentWipLimit } from "./agent-wip-limit.js";
import { persistInteractionResolutionWakes } from "./interaction-resolution-outbox.js";

/** Capture the authenticated server actor with the answer transaction. */
export function interactionResolutionMutationOptions<T extends { interaction: IssueThreadInteraction }>(
  durable: boolean,
  persistEffects: (tx: Db, result: T, wake: IssueAssignmentWakeupDeps) => Promise<void>,
  actor: AuthorizationActor,
) {
  // Copy only authorization fields. Display names and email addresses are not
  // execution authority and do not belong in the durable intent.
  const fields = ["type", "source", "userId", "sessionId", "companyIds", "memberships",
    "onBehalfOfMemberships", "isInstanceAdmin", "ignoreInstanceAdmin", "agentId", "companyId",
    "keyId", "keyScope", "runId", "onBehalfOfUserId", "authorizingUserId"] as const;
  const context = structuredClone(Object.fromEntries(fields.filter((key) => actor[key] !== undefined)
    .map((key) => [key, actor[key]]))) as AuthorizationActor;
  const wipOptions = agentWipLimit() === null ? {} : { wipAdmissionActor: { type: actor.type, source: actor.source } };
  return durable ? {
    ...wipOptions,
    afterRevisionResolveInTransaction: (tx: Db, result: T) =>
      persistInteractionResolutionWakes(tx, result.interaction, (wake) => persistEffects(tx, result, wake), context),
  } : wipOptions;
}
