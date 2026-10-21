import { upsertDefaultOrganizationGrant } from "../../default-connection-grant.js";
import type { ToolAccessMutationDb } from "../types.js";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { RAILWAY_SSH_SECRET_PATH } from "../../railway-ssh.js";
import { isRailwayConnection } from "../../railway.js";

export function createOrganizationGrantStore(db: Db) {
  async function ensureDefaultOrganizationGrant(
    connection: typeof toolConnections.$inferSelect,
    dbClient: ToolAccessMutationDb = db,
    onMutation?: (mutation: {
      previous: typeof connectionGrants.$inferSelect | null;
      current: typeof connectionGrants.$inferSelect;
    }) => void,
    /**
     * Scope provenance from the authorization that just completed, for the callers that have
     * one. The default organization grant is created before OAuth has issued any credentials,
     * so without this the grants API reads back a shared identity whose scope has no source
     * and no over-grant warning — while the connection record carries both.
     *
     * Deliberately scope fields only. The shared grant takes its credential lifecycle from the
     * connection, and writing `accessTokenExpiresAt` here would make an expired connection
     * look fresh to the refresh-due check and skip the reconnect prompt.
     */
    oauthProvenance?: {
      scopes: string[];
      scopeSource: "provider" | "requested_fallback";
      unrequestedScopes: string[];
      requestedScopes: string[];
    },
  ) {
    return upsertDefaultOrganizationGrant(dbClient, connection,
      isRailwayConnection(connection) ? [RAILWAY_SSH_SECRET_PATH] : [], onMutation, true, oauthProvenance);
  }
  return ensureDefaultOrganizationGrant;
}
