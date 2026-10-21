import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { companies, agents, issues, documents, issueDocuments, issueThreadInteractions,
  toolApplications, toolConnections, connectionGrants, companySecrets, userSecretDefinitions, type Db } from "@paperclipai/db";
import { credentialTransferAuthority } from "../../services/credential-transfer-authority.js";
import { transferFixture } from "./credential-transfer-fixture.js";

export async function seedTransferAuthority(db: Db) {
    const f = transferFixture();
  await db.insert(companies).values({ id: f.actor.companyId, name: "Transfer test", issuePrefix: `T${randomUUID().slice(0, 8)}` });
  await db.insert(agents).values({ id: f.actor.agentId, companyId: f.actor.companyId, name: "Test executor", adapterType: "process" });
  await db.insert(issues).values({ id: f.actor.issueId, companyId: f.actor.companyId, title: "Approved test operation", status: "in_progress" });
  for (const side of ["source", "destination"] as const) {
    const binding = f.request[side];
    const appId = randomUUID();
    const secretId = Object.keys(binding.credentialVersions)[0]!;
    const definitionId = randomUUID();
    await db.insert(toolApplications).values({ id: appId, companyId: f.actor.companyId, name: side, type: "mcp_http" });
    await db.insert(toolConnections).values({ id: binding.connectionId, companyId: f.actor.companyId, applicationId: appId,
      name: side, uid: side, transport: "mcp_remote", credentialPolicy: "per_user", enabled: true, status: "active",
      updatedAt: new Date(binding.connectionVersion) });
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: f.actor.companyId, key: side, name: side });
    await db.insert(companySecrets).values({ id: secretId, companyId: f.actor.companyId, key: side, name: side, scope: "user",
      ownerUserId: f.actor.userId, userSecretDefinitionId: definitionId });
    await db.insert(connectionGrants).values({ id: binding.grantId, companyId: f.actor.companyId, connectionId: binding.connectionId,
      kind: "user", subjectUserId: f.actor.userId, updatedAt: new Date(binding.grantVersion),
      credentialSecretRefs: [{ secretId, configPath: "TOKEN", versionSelector: "latest" }] });
  }
  for (const [key, ref, kind] of [
    ["permission", f.request.permissionApproval, "r2_permission_window"],
    ["issuance", f.request.issuanceApproval, "r2_credential_transfer"],
  ] as const) {
    await db.insert(documents).values({ id: ref.documentId, companyId: f.actor.companyId,
      latestRevisionId: ref.revisionId, latestBody: JSON.stringify({ ...f.operation, operation: kind }) });
    await db.insert(issueDocuments).values({ companyId: f.actor.companyId, issueId: f.actor.issueId, documentId: ref.documentId, key });
    await db.insert(issueThreadInteractions).values({ id: ref.interactionId, companyId: f.actor.companyId, issueId: f.actor.issueId,
      kind: "request_confirmation", status: "accepted", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      addresseeUserId: f.actor.userId, resolvedByUserId: f.actor.userId,
      payload: { version: 1, prompt: "Execute only this test operation.", target: {
        type: "issue_document", issueId: f.actor.issueId, key, documentId: ref.documentId, revisionId: ref.revisionId,
      } }, result: { version: 1, outcome: "accepted" } });
  }
  const gateway = { authorizeCredentialTransfer: vi.fn().mockResolvedValue(undefined) };
  const authority = credentialTransferAuthority(db, gateway, "fake-session", { source: ["fake-issue"], destination: ["fake-create"], operations: {
    inspect: { source: ["fake-issue"] }, arm: { source: ["fake-issue"] }, activate: { source: ["fake-issue"] },
    issue: { source: ["fake-issue"] }, createOnly: { destination: ["fake-create"] }, readCreated: { destination: ["fake-create"] },
  } });
  const check = () => authority.check(f.actor, f.request);
  return Object.assign(f, { gateway, authority, check });
}
