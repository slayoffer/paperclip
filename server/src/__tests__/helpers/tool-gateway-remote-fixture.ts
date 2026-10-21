import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { companySecretBindings, connectionGrants, toolApplications, toolCatalogEntries, toolConnections, type Db } from "@paperclipai/db";

export async function createRemoteMcpTool(
  db: Db,
  companyId: string,
  input: {
    applicationKey?: string | null;
    connectionName?: string;
    url?: string;
    toolName?: string;
    title?: string | null;
    connectionEnabled?: boolean;
    connectionStatus?: "draft" | "active" | "disabled" | "archived";
    healthStatus?: "unknown" | "healthy" | "degraded" | "failed" | "unchecked" | "ok" | "error" | "missing_secret";
    catalogStatus?: "active" | "disabled" | "quarantined" | "removed";
    quarantinedAt?: Date | null;
    credentialRefs?: typeof toolConnections.$inferInsert["credentialRefs"];
    credentialSecretRefs?: typeof toolConnections.$inferInsert["credentialSecretRefs"];
    riskLevel?: "read" | "write" | "destructive";
    stdioScript?: string;
    envKeys?: string[];
    connectionConfig?: Record<string, unknown>;
  } = {},
) {
  const applicationKey = input.applicationKey ?? `app-${randomUUID().slice(0, 8)}`;
  let application = await db
    .select()
    .from(toolApplications)
    .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.applicationKey, applicationKey)))
    .limit(1)
    .then((rows) => rows[0]);
  if (!application) {
    [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey,
      name: `Remote app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
  }
  const [connection] = await db.insert(toolConnections).values({
    companyId,
    applicationId: application.id,
    name: input.connectionName ?? `Remote connection ${randomUUID()}`,
    uid: `test/${randomUUID()}`,
    transport: "mcp_remote",
    status: input.connectionStatus ?? "active",
    enabled: input.connectionEnabled ?? true,
    healthStatus: input.healthStatus ?? "ok",
    config: { url: input.url ?? "https://mcp.example.test/mcp", ...(input.connectionConfig ?? {}) },
    transportConfig: { url: input.url ?? "https://mcp.example.test/mcp", ...(input.connectionConfig ?? {}) },
    credentialRefs: input.credentialRefs ?? [],
    credentialSecretRefs: input.credentialSecretRefs ?? [],
  }).returning();
  await db.insert(connectionGrants).values({
    companyId,
    connectionId: connection.id,
    kind: "organization",
    credentialSecretRefs: connection.credentialSecretRefs,
    status: "active",
    isDefault: true,
  });
  if (input.credentialRefs?.length || input.credentialSecretRefs?.length) {
    await db.insert(companySecretBindings).values([
      ...(input.credentialRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: `credentials.${ref.name}`,
      })),
      ...(input.credentialSecretRefs ?? []).map((ref) => ({
        companyId,
        secretId: ref.secretId,
        targetType: "tool_connection" as const,
        targetId: connection!.id,
        configPath: ref.configPath,
        versionSelector: String(ref.versionSelector ?? "latest"),
        required: ref.required ?? true,
        label: ref.label ?? null,
      })),
    ]).onConflictDoNothing();
  }
  const toolName = input.toolName ?? "kv_set";
  const [catalogEntry] = await db.insert(toolCatalogEntries).values({
    companyId,
    applicationId: application.id,
    connectionId: connection!.id,
    entryKind: "tool",
    name: `${toolName}-${randomUUID()}`,
    toolName,
    title: input.title ?? "KV Set",
    description: `Call ${toolName}`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    riskLevel: input.riskLevel ?? "write",
    isReadOnly: (input.riskLevel ?? "write") === "read",
    isWrite: (input.riskLevel ?? "write") === "write",
    isDestructive: (input.riskLevel ?? "write") === "destructive",
    status: input.catalogStatus ?? "active",
    versionHash: randomUUID(),
    quarantinedAt: input.quarantinedAt ?? null,
  }).returning();
  return { application, connection: connection!, catalogEntry: catalogEntry! };
}
