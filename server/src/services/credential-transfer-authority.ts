import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { connectionGrants, documents, issueDocuments, issues, issueThreadInteractions, toolConnections, type Db } from "@paperclipai/db";
import { credentialTransferOperationSchema, type CreateCredentialTransfer } from "@paperclipai/shared";
import { CredentialTransferError, type TransferActor, type TransferAuthority } from "./credential-transfer.js";
import { validateConnectionGrantSecretOwnership } from "./connection-credentials.js";
import type { ToolGatewayService } from "./tool-gateway.js";

/** Tool names come from a server-owned provider adapter, never the request or an operation document. */
export function credentialTransferAuthority(db: Db, gateway: Pick<ToolGatewayService, "authorizeCredentialTransfer">,
  sessionToken: string, tools: { source: readonly string[]; destination: readonly string[] }): TransferAuthority {
  const deny = () => { throw new CredentialTransferError(403, "transfer_authority_invalid"); };
  return {
    async check(actor: TransferActor, request: CreateCredentialTransfer) {
      const [issue] = await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(
        eq(issues.companyId, actor.companyId), eq(issues.id, actor.issueId),
      ));
      if (!issue || ["done", "cancelled"].includes(issue.status)) deny();
      const operations = [];
      for (const [ref, kind] of [
        [request.permissionApproval, "r2_permission_window"],
        [request.issuanceApproval, "r2_credential_transfer"],
      ] as const) {
        const [card] = await db.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, actor.companyId), eq(issueThreadInteractions.issueId, actor.issueId),
          eq(issueThreadInteractions.id, ref.interactionId),
        ));
        const [document] = await db.select({ latestRevisionId: documents.latestRevisionId, body: documents.latestBody })
          .from(documents).innerJoin(issueDocuments, and(eq(issueDocuments.documentId, documents.id),
            eq(issueDocuments.companyId, actor.companyId), eq(issueDocuments.issueId, actor.issueId)))
          .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, ref.documentId)));
        const payload = card?.payload;
        if (!card || card.kind !== "request_confirmation" || card.status !== "accepted"
          || card.effectiveResolverPolicy !== "human_only" || card.requestedResolverPolicy !== "human_only"
          || !card.resolvedByUserId || card.resolvedByAgentId || card.addresseeAgentId
          || card.addresseeUserId !== card.resolvedByUserId || card.resolvedByUserId !== actor.userId
          || !card.result || !("outcome" in card.result) || card.result.outcome !== "accepted"
          || !("target" in payload) || payload.target?.type !== "issue_document"
          || payload.target.documentId !== ref.documentId || payload.target.revisionId !== ref.revisionId
          || (payload.target.issueId && payload.target.issueId !== actor.issueId)
          || !document || document.latestRevisionId !== ref.revisionId) deny();
        let body: unknown;
        try { body = JSON.parse(document!.body); } catch { deny(); }
        const operation = credentialTransferOperationSchema.safeParse(body);
        if (!operation.success || operation.data.operation !== kind) deny();
        operations.push(operation.data!);
      }
      if (!isDeepStrictEqual({ ...operations[0], operation: "r2_credential_transfer" }, operations[1])) deny();
      for (const side of ["source", "destination"] as const) {
        const binding = request[side];
        const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, actor.companyId), eq(toolConnections.id, binding.connectionId)));
        const [grant] = await db.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, actor.companyId), eq(connectionGrants.id, binding.grantId)));
        if (!connection || connection.credentialPolicy !== "per_user" || connection.credentialSource !== "paperclip_vault"
          || !connection.enabled || connection.status !== "active"
          || !grant || grant.connectionId !== connection.id || grant.status !== "active"
          || grant.kind !== "user" || grant.subjectUserId !== actor.userId
          || connection.updatedAt.toISOString() !== binding.connectionVersion
          || grant.updatedAt.toISOString() !== binding.grantVersion || !grant.credentialSecretRefs.length) deny();
        const versions: Record<string, number> = {};
        for (const ref of grant!.credentialSecretRefs) {
          const secret = await validateConnectionGrantSecretOwnership(db, connection!, grant!, ref);
          if (secret.status !== "active" || (ref.versionSelector !== undefined && ref.versionSelector !== "latest")) deny();
          versions[secret.id] = secret.latestVersion;
        }
        if (!isDeepStrictEqual(versions, binding.credentialVersions)) deny();
        await gateway.authorizeCredentialTransfer({ ...actor, sessionToken,
          connectionId: binding.connectionId, grantId: binding.grantId, toolNames: tools[side] });
      }
      return operations[1]!;
    },
  };
}
