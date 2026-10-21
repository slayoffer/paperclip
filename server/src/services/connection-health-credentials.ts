import { and, eq, or, sql } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Invalidate only connections that consume the rotated secret's latest version. */
export async function invalidateRotatedConnectionHealth(
  db: Transaction,
  companyId: string,
  secretId: string,
) {
  const usesLatest = (
    refs: typeof toolConnections.credentialRefs | typeof toolConnections.credentialSecretRefs | typeof connectionGrants.credentialSecretRefs,
    versionField = "versionSelector",
  ) => sql`exists (
    select 1 from jsonb_array_elements(${refs}) ref
    where ref->>'secretId' = ${secretId}
      and coalesce(ref->>${versionField}, 'latest') = 'latest'
  )`;
  await db.update(toolConnections).set({
    healthStatus: "unchecked",
    healthMessage: "Credentials changed. Test the connection before use.",
    healthCheckedAt: null,
    lastHealthAt: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(
    eq(toolConnections.companyId, companyId),
    eq(toolConnections.connectionPurpose, "tool"),
    or(
      usesLatest(toolConnections.credentialRefs, "version"),
      usesLatest(toolConnections.credentialSecretRefs),
      sql`exists (
        select 1 from ${connectionGrants}
        where ${connectionGrants.connectionId} = ${toolConnections.id}
          and ${connectionGrants.companyId} = ${companyId}
          and ${connectionGrants.status} = 'active'
          and ${usesLatest(connectionGrants.credentialSecretRefs)}
      )`,
    ),
  ));
}
