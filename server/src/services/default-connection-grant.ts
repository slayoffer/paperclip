import { and, eq } from "drizzle-orm";
import { connectionGrants, type Db, type toolConnections } from "@paperclipai/db";
import { connectionCredentialConfigPath, type ToolCredentialSecretRef, type UpdateToolConnection } from "@paperclipai/shared";

type Connection = typeof toolConnections.$inferSelect;

export function resolveConnectionCredentialUpdate(existing: Connection, input: UpdateToolConnection) {
  const credentialPolicy = input.credentialPolicy ?? existing.credentialPolicy;
  const credentialRefs = input.credentialRefs ?? existing.credentialRefs;
  const credentialSecretRefs: ToolCredentialSecretRef[] = input.credentialSecretRefs ?? (
    input.credentialRefs !== undefined && credentialPolicy === "shared"
      ? [
          ...existing.credentialSecretRefs.filter((ref) =>
            ![...existing.credentialRefs, ...credentialRefs].some((placement) => connectionCredentialConfigPath(placement) === ref.configPath)),
          ...credentialRefs.map((ref) => ({
            ...existing.credentialSecretRefs.find((previous) => previous.configPath === connectionCredentialConfigPath(ref)),
            configPath: connectionCredentialConfigPath(ref),
            secretId: ref.secretId,
            versionSelector: ref.version ?? "latest",
          })),
        ]
      : existing.credentialSecretRefs
  );
  const credentials = { credentialPolicy, credentialRefs, credentialSecretRefs };
  // Placement metadata, reference order, and default version spelling do not
  // replace credentials. Repeating them must preserve revoked authorization.
  const identities = (value: Pick<Connection, "credentialRefs" | "credentialSecretRefs">, includePath = true) =>
    [...new Set([
      ...value.credentialRefs.map((ref) => JSON.stringify([
        includePath ? connectionCredentialConfigPath(ref) : null, ref.secretId, ref.version ?? "latest",
      ])),
      ...value.credentialSecretRefs.map((ref) => JSON.stringify([
        includePath ? ref.configPath : null, ref.secretId, ref.versionSelector ?? "latest",
      ])),
    ])].sort();
  const previous = identities(existing);
  const next = identities(credentials);
  const previousSecrets = identities(existing, false);
  return {
    ...credentials,
    changed: JSON.stringify(next) !== JSON.stringify(previous),
    replaced: identities(credentials, false).some((identity) => !previousSecrets.includes(identity)),
  };
}

type GrantMutation = {
  previous: typeof connectionGrants.$inferSelect | null;
  current: typeof connectionGrants.$inferSelect;
};

type Grant = typeof connectionGrants.$inferSelect;
type GrantDb = Pick<Db, "select" | "insert" | "update">;

/**
 * Scope provenance from the authorization that just completed. Scope fields only: the shared grant
 * takes its credential lifecycle from the connection.
 */
export type DefaultGrantOAuthProvenance = {
  scopes: string[];
  scopeSource: "provider" | "requested_fallback";
  unrequestedScopes: string[];
  requestedScopes: string[];
};

export function upsertDefaultOrganizationGrant(
  dbClient: GrantDb, connection: Connection, preserveConfigPaths?: string[],
  onMutation?: (mutation: GrantMutation) => void,
): Promise<Grant>;
export function upsertDefaultOrganizationGrant(
  dbClient: GrantDb, connection: Connection, preserveConfigPaths: string[],
  onMutation: ((mutation: GrantMutation) => void) | undefined, allowReauthorization: true,
  oauthProvenance?: DefaultGrantOAuthProvenance,
): Promise<Grant>;
export function upsertDefaultOrganizationGrant(
  dbClient: GrantDb, connection: Connection, preserveConfigPaths: string[],
  onMutation: ((mutation: GrantMutation) => void) | undefined, allowReauthorization: boolean,
  oauthProvenance?: DefaultGrantOAuthProvenance,
): Promise<Grant | null>;
export async function upsertDefaultOrganizationGrant(
  dbClient: GrantDb,
  connection: Connection,
  preserveConfigPaths: string[] = [],
  onMutation?: (mutation: GrantMutation) => void,
  allowReauthorization = true,
  oauthProvenance?: DefaultGrantOAuthProvenance,
) {
  const providerTenantWithOauth = (current: Grant["providerTenant"]) =>
    oauthProvenance
      ? {
          ...(current ?? {}),
          oauth: {
            ...(current?.oauth ?? {}),
            scopes: oauthProvenance.scopes,
            scopeSource: oauthProvenance.scopeSource,
            unrequestedScopes: oauthProvenance.unrequestedScopes,
            requestedScopes: oauthProvenance.requestedScopes,
          },
        }
      : current;
  const [existing] = await dbClient
    .select()
    .from(connectionGrants)
    .where(
      and(
        eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
        eq(connectionGrants.kind, "organization"),
        eq(connectionGrants.isDefault, true),
      ),
    )
    .limit(1);
  // Removing credentials can synchronize an active grant. Only reconnect or
  // credential replacement can create authorization after revocation.
  if (!allowReauthorization && existing?.status !== "active") return null;
  if (existing) {
    // OAuth connections create their organization grant before the browser
    // callback has issued any credentials. Reconnects can rotate those
    // credentials later as well. Keep the execution grant synchronized with
    // the connection so the gateway projects the current secrets instead of
    // sending an unauthenticated request after an apparently successful
    // setup. Reconnecting is also the explicit recovery path for a revoked
    // shared identity, so it is correct to reactivate that default grant here.
    const [updated] = await dbClient
      .update(connectionGrants)
      .set({
        credentialSecretRefs: preserveConfigPaths.length > 0
          ? [...connection.credentialSecretRefs, ...existing.credentialSecretRefs.filter((ref) => preserveConfigPaths.includes(ref.configPath) && !connection.credentialSecretRefs.some((candidate) => candidate.configPath === ref.configPath))]
          : connection.credentialSecretRefs,
        ...(oauthProvenance
          ? { providerTenant: providerTenantWithOauth(existing.providerTenant) }
          : {}),
        status: "active",
        revokedAt: null,
        revokedByAgentId: null,
        revokedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(connectionGrants.id, existing.id))
      .returning();
    if (!updated)
      throw new Error("Failed to update default connection grant");
    onMutation?.({ previous: existing, current: updated });
    return updated;
  }
  const [created] = await dbClient
    .insert(connectionGrants)
    .values({
      companyId: connection.companyId,
      connectionId: connection.id,
      kind: "organization",
      credentialSecretRefs: connection.credentialSecretRefs,
      ...(oauthProvenance
        ? { providerTenant: providerTenantWithOauth(null) }
        : {}),
      status: "active",
      isDefault: true,
    })
    .returning();
  if (!created) throw new Error("Failed to create default connection grant");
  onMutation?.({ previous: null, current: created });
  return created;
}
