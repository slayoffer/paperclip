import { and, eq } from "drizzle-orm";
import { connectionGrants, type Db, type toolConnections } from "@paperclipai/db";

type GrantMutation = {
  previous: typeof connectionGrants.$inferSelect | null;
  current: typeof connectionGrants.$inferSelect;
};

export async function upsertDefaultOrganizationGrant(
  dbClient: Pick<Db, "select" | "insert" | "update">,
  connection: typeof toolConnections.$inferSelect,
  preserveConfigPaths: string[] = [],
  onMutation?: (mutation: GrantMutation) => void,
) {
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
      status: "active",
      isDefault: true,
    })
    .returning();
  if (!created) throw new Error("Failed to create default connection grant");
  onMutation?.({ previous: null, current: created });
  return created;
}
