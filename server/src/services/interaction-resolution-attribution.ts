import type { InteractionActor } from "./interaction-resolution-input.js";

/** These fields are saved with the first resolution, under the existing pending-state guard. */
export function interactionResolutionAttribution(actor: InteractionActor) {
  return {
    resolvedByAgentId: actor.agentId ?? null,
    resolvedByUserId: actor.userId ?? null,
    resolvedVia: actor.resolvedVia ?? null,
  };
}
