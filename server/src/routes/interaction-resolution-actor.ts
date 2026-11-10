import type { Request } from "express";
import type { InteractionActor } from "../services/interaction-resolution-input.js";
import { getActorInfo } from "./authz.js";

/** Authentication provenance must come from middleware, never from the body or resolver ID. */
export function interactionResolvedVia(actor: Request["actor"]): InteractionActor["resolvedVia"] {
  if (actor.type === "agent" && (actor.source === "agent_key" || actor.source === "agent_jwt")) return "agent_key";
  if (actor.type !== "board") return null;
  if (actor.source === "board_key") return "board_api_key";
  if (actor.source === "session") return "user_session";
  return null;
}

export function interactionResolutionActor(req: Request): InteractionActor {
  const actor = getActorInfo(req);
  return {
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    resolvedVia: interactionResolvedVia(req.actor),
  };
}
