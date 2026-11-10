import type { InteractionActor } from "./interaction-resolution-input.js";

/** These fields are saved with the first resolution, under the existing pending-state guard. */
export function interactionResolutionAttribution(actor: InteractionActor) {
  return {
    resolvedByAgentId: actor.agentId ?? null,
    resolvedByUserId: actor.userId ?? null,
    resolvedVia: actor.resolvedVia ?? null,
  };
}

/** Authentication provenance must come from middleware, never from the body or resolver ID. */
export function interactionResolvedVia<T extends { type: string; source?: string }>(actor: T): InteractionActor["resolvedVia"] {
  if (actor.type === "agent" && (actor.source === "agent_key" || actor.source === "agent_jwt")) return "agent_key";
  if (actor.type !== "board") return null;
  if (actor.source === "board_key") return "board_api_key";
  if (actor.source === "session") return "user_session";
  return null;
}
