import type { ResolutionVia } from "@paperclipai/shared";
import { SYSTEM_RESOLUTION_VIA } from "./interaction-resolution-attribution.js";

export type StatusCardActor = { agentId: string | null; userId: string | null; via?: ResolutionVia | null };

export function statusCardCancellationActor(actor?: StatusCardActor) {
  return {
    actorAgentId: actor?.agentId ?? null,
    actorUserId: actor?.userId ?? null,
    actorResolvedVia: actor
      ? (actor.agentId || actor.userId ? actor.via ?? null : null)
      : SYSTEM_RESOLUTION_VIA,
  };
}
