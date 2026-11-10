import { sql } from "drizzle-orm";
import { issueThreadInteractions } from "@paperclipai/db";
import type { ActorInfo } from "../types.js";

export function oauthResolutionAttribution(actor: ActorInfo | undefined) {
  return {
    // Late provider callbacks retain the first resolution's channel, including old nulls.
    resolvedVia: sql`CASE WHEN ${issueThreadInteractions.status} = 'pending'
      AND ${issueThreadInteractions.resolvedAt} IS NULL
      THEN ${actor?.resolvedVia ?? null} ELSE ${issueThreadInteractions.resolvedVia} END`,
  };
}
