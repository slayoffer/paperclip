import type { Db, issues, issueThreadInteractions } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import type { InteractionActor } from "./interaction-resolution-input.js";
import type { InteractionResolutionMutationOptions, ResolvedInteractionResult, issueThreadInteractionService } from "./issue-thread-interactions.js";
import { resolveWithInteractionRevision, type InteractionAnswerPreconditions } from "./interaction-revision.js";

type Service = ReturnType<typeof issueThreadInteractionService>;
export async function resolveInteractionRevisionForService<T>(args: {
  db: Db; issue: { id: string; companyId: string }; interactionId: string;
  input: InteractionAnswerPreconditions; operation: string; actor: InteractionActor;
  mutationOptions: InteractionResolutionMutationOptions;
  createService: (tx: Db) => Service;
  beforeLock: (tx: Db) => Promise<void>;
  authorize: (row: typeof issueThreadInteractions.$inferSelect) => void;
  hydrate: (row: typeof issueThreadInteractions.$inferSelect) => IssueThreadInteraction;
  resolve: (service: Service, fresh: typeof issues.$inferSelect, options: InteractionResolutionMutationOptions) => Promise<T>;
  replay: (interaction: IssueThreadInteraction) => T;
  interaction: (result: T) => IssueThreadInteraction;
}): Promise<T> {
  const { db, issue, interactionId, input, operation, actor, mutationOptions,
    createService, beforeLock, authorize, hydrate, resolve, replay, interaction } = args;
  const effects: Array<(committedDb: Db) => Promise<void>> = [];
  const result = await resolveWithInteractionRevision({
    db, issue, interactionId, input, operation, actor,
    beforeLock, authorize, hydrate, replay, interaction,
    resolve: async (tx, fresh) => {
      const result = await resolve(createService(tx), fresh, {
        ...mutationOptions,
        deferConfirmationCommitEffects: (effect) => effects.push(effect),
      });
      await mutationOptions.afterRevisionResolveInTransaction?.(tx,
        operation === "accept" ? result as ResolvedInteractionResult : { interaction: interaction(result), createdIssues: [] });
      return result;
    },
  });
  for (const effect of effects) {
    if (mutationOptions.deferConfirmationCommitEffects) mutationOptions.deferConfirmationCommitEffects(effect);
    else await effect(db);
  }
  return result;
}
