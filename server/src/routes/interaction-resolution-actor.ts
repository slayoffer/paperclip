import { resolutionViaFromActor } from "../services/interaction-resolution-attribution.js";
import type { Request } from "express";
import type { InteractionActor } from "../services/interaction-resolution-input.js";
import { getActorInfo } from "./authz.js";

export { resolutionViaFromActor };

export function interactionResolutionActor(req: Request): InteractionActor {
  const actor = getActorInfo(req);
  return {
    agentId: actor.agentId,
    userId: actor.actorType === "user" ? actor.actorId : null,
    via: resolutionViaFromActor(req.actor),
  };
}

export function interactionIssueUpdateActor(req: Request) {
  const actor = interactionResolutionActor(req);
  return {
    actorAgentId: actor.agentId,
    actorUserId: actor.userId,
    actorResolvedVia: actor.via,
  };
}
