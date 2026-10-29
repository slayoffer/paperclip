import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, principalPermissionGrants, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";

export async function grantAgentStatsRead(db: Db, companyId: string, agentId: string, userId: string | null) {
  const result = await db.transaction(async (tx) => {
    const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, agentId), eq(agents.companyId, companyId),
    ));
    if (!agent) throw notFound("Agent not found");
    const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, agentId),
    ));
    if (!membership) throw conflict("Agent company membership is required");

    // Conflict handling preserves an existing grant, including its scope and audit fields.
    const [inserted] = await tx.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: agentId,
      permissionKey: "stats:read", scope: null, grantedByUserId: userId,
    }).onConflictDoNothing().returning();
    if (!inserted) return { created: false, publication: null };

    const { publication } = await persistActivity(tx as unknown as Db, {
      companyId, actorType: "user", actorId: userId ?? "board",
      action: "agent.stats_read_granted", entityType: "agent", entityId: agentId,
      details: { permissionKey: "stats:read", grantId: inserted.id, membershipId: membership.id },
    });
    return { created: true, publication };
  });
  if (result.publication) publishActivity(result.publication);
  return { companyId, agentId, permissionKey: "stats:read" as const, created: result.created };
}
