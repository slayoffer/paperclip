import { and, eq, inArray, or } from "drizzle-orm";
import { toolApplications, toolConnections } from "@paperclipai/db";
import { isToolConnectionAttentionHealth } from "@paperclipai/shared";

/** Call errors preserve remote catalogs. Calls still validate access and credentials. */
export function canDeliverRuntimeMcpConnection(
  connection: Pick<typeof toolConnections.$inferSelect, "transport" | "healthStatus" | "credentialPolicy">,
): boolean {
  return connection.credentialPolicy === "per_user"
    || (connection.transport === "mcp_remote" && connection.healthStatus === "error")
    || !isToolConnectionAttentionHealth(connection.healthStatus);
}

export function connectedMcpConnectionFilter(companyId: string) {
  return and(
    eq(toolConnections.companyId, companyId),
    inArray(toolConnections.transport, ["mcp_remote", "local_stdio", "rest_api"]),
    eq(toolConnections.status, "active"),
    eq(toolConnections.enabled, true),
    // A personal connection has no company-level credential to probe. A
    // credential-less health sweep can therefore mark it as errored even
    // while the responsible user's grant is valid. Keep its cached active
    // catalog discoverable; execution resolves and validates that user's
    // grant, and a successful call restores the shared health indicator.
    or(
      inArray(toolConnections.healthStatus, ["ok", "healthy"]),
      // A remote call error describes availability, not catalog access.
      // Keep tools discoverable so explicit retries can restore health.
      and(
        eq(toolConnections.transport, "mcp_remote"),
        eq(toolConnections.healthStatus, "error"),
      ),
      eq(toolConnections.credentialPolicy, "per_user"),
    ),
    eq(toolApplications.companyId, companyId),
    inArray(toolApplications.type, ["mcp_http", "mcp_stdio", "rest_api"]),
    eq(toolApplications.status, "active"),
  );
}
