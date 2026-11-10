import type { ResolutionVia } from "@paperclipai/shared";
import type { InteractionActor } from "./interaction-resolution-input.js";

export const SYSTEM_RESOLUTION_VIA = { resolvedVia: "system", resolvedViaKeyId: null } satisfies ResolutionVia;
export const CHAT_RESOLUTION_VIA = { resolvedVia: "chat_channel", resolvedViaKeyId: null } satisfies ResolutionVia;

/** These fields are saved with the first resolution, under the existing pending-state guard. */
export function interactionResolutionAttribution(actor: InteractionActor) {
  return {
    resolvedByAgentId: actor.agentId ?? null,
    resolvedByUserId: actor.userId ?? null,
    resolvedVia: actor.via?.resolvedVia ?? null,
    resolvedViaKeyId: actor.via?.resolvedViaKeyId ?? null,
  };
}

/** Authentication provenance must come from middleware, never from the body or resolver ID. */
export function resolutionViaFromActor<T extends { source?: string; keyId?: string | null }>(actor: T): ResolutionVia | null {
  switch (actor.source) {
    case "session": return { resolvedVia: "user_session", resolvedViaKeyId: null };
    case "board_key": return actor.keyId ? { resolvedVia: "board_api_key", resolvedViaKeyId: actor.keyId } : null;
    case "agent_key":
    case "agent_jwt": return { resolvedVia: "agent_key", resolvedViaKeyId: null };
    default: return null;
  }
}
