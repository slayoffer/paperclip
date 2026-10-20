import { and, eq } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

/** Keep an authorized health probe on the selected identity during credential refresh. */
export async function selectVaultConnectionGrant(
  db: Db,
  connection: typeof toolConnections.$inferSelect,
  actor: { actorType?: string; actorId?: string | null; credentialGrantId?: string } | undefined,
  urls: { setupUrl: string; reconnectUrl: string },
): Promise<typeof connectionGrants.$inferSelect | null> {
  if (actor?.credentialGrantId) {
    const [selected] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.id, actor.credentialGrantId),
      eq(connectionGrants.companyId, connection.companyId),
      eq(connectionGrants.connectionId, connection.id),
      eq(connectionGrants.status, "active"),
    )).limit(1);
    if (!selected) throw unprocessable("The selected authorization is no longer active", {
      code: "oauth_reauthorization_required", ...urls,
    });
    return selected;
  }
  const actorUserId =
    actor?.actorType === "user" ? (actor.actorId ?? null) : null;
  if (actorUserId) {
    const [personal] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, actorUserId),
        ),
      )
      .limit(1);
    if (personal) {
      if (personal.status !== "active") {
        throw unprocessable("OAuth authorization must be reconnected", {
          code: "oauth_reauthorization_required",
          setupUrl: urls.setupUrl,
          reconnectUrl: urls.reconnectUrl,
        });
      }
      return personal;
    }
  }
  if (!actorUserId && connection.credentialPolicy === "per_user") {
    // A personal-only connection is intentionally fixed to one identity.
    // Background health/catalog checks have no acting user, but may safely
    // exercise that sole owner-bound grant without turning it into a shared
    // credential or making it available to a different caller.
    const personalGrants = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.status, "active"),
        ),
      )
      .limit(2);
    if (personalGrants.length === 1) return personalGrants[0]!;
  }
  if (connection.credentialPolicy === "per_user") {
    throw unprocessable(
      "This connection needs the current user's authorization",
      {
        code: "user_authorization_required",
        setupUrl: urls.setupUrl,
        reconnectUrl: urls.reconnectUrl,
      },
    );
  }
  const [organization] = await db
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
  if (organization?.status === "active") return organization;
  return null;
}
