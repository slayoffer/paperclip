import type { Request } from "express";
import type { connectionIntentService } from "../services/connection-intents.js";
import { forbidden } from "../errors.js";

export function connectionIntentOAuthFinisher(
  intents: Pick<ReturnType<typeof connectionIntentService>, "loadIntent" | "complete" | "updatePhase">,
  deliver?: (interactionId: string) => Promise<unknown>,
) {
  return async (input: {
    interactionId: string;
    connectionId?: string;
    userId: string;
    actor: Request["actor"];
    outcome: "connected" | "declined" | "failed";
    canManageOrganizationGrant: boolean;
    bypassCurrentMembershipCheck: boolean;
  }) => {
    const loaded = await intents.loadIntent(input.interactionId);
    if (loaded.interaction.addresseeUserId !== input.userId) {
      throw forbidden("OAuth callback user does not match the connection request");
    }
    if (loaded.interaction.status !== "pending") return loaded.interaction;
    const interaction = input.outcome === "connected" && input.connectionId
      ? await intents.complete(input.interactionId, input.connectionId, input.userId, {
          canManageOrganizationGrant: input.canManageOrganizationGrant,
          bypassCurrentMembershipCheck: input.bypassCurrentMembershipCheck,
          via: null,
        })
      : await intents.updatePhase(input.interactionId, "needs_retry", input.userId, {
          bypassCurrentMembershipCheck: input.bypassCurrentMembershipCheck,
        });
    if (interaction.status === "accepted") await deliver?.(input.interactionId);
    return interaction;
  };
}
