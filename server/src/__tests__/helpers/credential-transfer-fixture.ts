import { randomUUID } from "node:crypto";
import type { CreateCredentialTransfer, CredentialTransferOperation } from "@paperclipai/shared";
import { credentialTransferService, CredentialTransferError, type TransferActor, type TransferRow, type TransferJournal, type TransferProviders } from "../../services/credential-transfer.js";

export const CANARIES = ["FAKE-ACCESS-CANARY-DO-NOT-LOG", "FAKE-SECRET-CANARY-DO-NOT-LOG"];
export function transferFixture() {
  let clock = Date.parse("2026-10-18T12:00:00.000Z");
  const actor: TransferActor = { companyId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), userId: "test-person" };
  const binding = () => ({ connectionId: randomUUID(), connectionVersion: new Date(clock).toISOString(), grantId: randomUUID(),
    grantVersion: new Date(clock).toISOString(), credentialVersions: { [randomUUID()]: 1 } });
  const approval = () => ({ interactionId: randomUUID(), documentId: randomUUID(), revisionId: randomUUID() });
  const request: CreateCredentialTransfer = { issueId: actor.issueId, source: binding(), destination: binding(),
    permissionApproval: approval(), issuanceApproval: approval() };
  const operation: CredentialTransferOperation = { version: 1, operation: "r2_credential_transfer", ...actor,
    source: request.source, destination: request.destination, accountId: "a".repeat(32), bucket: "test-monitor-bucket",
    jurisdiction: "default", permission: "Object Read", credentialName: "synthiq-clpn-r2-monitor",
    credentialExpiresAt: new Date(clock + 90 * 86400000).toISOString(), grantDeadline: new Date(clock + 3600000).toISOString(),
    executionDeadline: new Date(clock + 1800000).toISOString(), project: "synthiq-infra", environment: "prod", path: "/clpn-ha",
    names: ["CLPN_R2_MONITOR_ACCESS_KEY_ID", "CLPN_R2_MONITOR_SECRET_ACCESS_KEY"] };
  const rows = new Map<string, TransferRow>();
  const locks = new Set<string>();
  const snapshots: TransferRow[] = [];
  const trace: string[] = [];
  const tickets = new Map<string, { operation: CredentialTransferOperation; issued: boolean; closed: boolean; revoked: boolean }>();
  const vault = new Map<string, string>();
  const grants = new Set(["b".repeat(32)]);
  let issueCount = 0;
  let fail: string | null = null;
  let checkHook: (() => void | Promise<void>) | null = null;
  const fault = (step: string) => {
    trace.push(step);
    if (fail === step) throw new Error(CANARIES.join(" "));
  };
  const journal: TransferJournal = {
    async exclusive(companyId, _connectionId, work) {
      const key = companyId;
      if (locks.has(key)) throw new CredentialTransferError(409, "transfer_busy");
      locks.add(key);
      try { return await work(async () => {}); } finally { locks.delete(key); }
    },
    async insert(row) {
      if ([...rows.values()].some(r => r.actor.companyId === row.actor.companyId
        && (r.bindings.issuanceApproval.interactionId === row.bindings.issuanceApproval.interactionId
          || r.bindings.permissionApproval.interactionId === row.bindings.permissionApproval.interactionId))) {
        throw new CredentialTransferError(409, "approval_already_used");
      }
      rows.set(row.id, structuredClone(row));
    },
    async save(row) { rows.set(row.id, structuredClone(row)); snapshots.push(structuredClone(row)); },
    async get(companyId, id) { const row = rows.get(id); return row?.actor.companyId === companyId ? structuredClone(row) : null; },
    async unfinished(companyId) { return [...rows.values()].filter(r => r.actor.companyId === companyId && !["complete", "revoked"].includes(r.state)).map(r => structuredClone(r)); },
  };
  const inventory = { complete: true, accountId: operation.accountId, bucket: operation.bucket, jurisdiction: operation.jurisdiction,
    bucketOwned: true, identityExclusive: true, effectivePermission: "Object Read" as const, baselineGrantIds: [...grants], destinationCount: 0,
    safeAutomaticRemoval: true };
  const ticket = (id: string) => {
    const value = tickets.get(id);
    if (!value || value.closed || clock >= Date.parse(value.operation.grantDeadline)) throw new Error(CANARIES[0]);
    return value;
  };
  const providers: TransferProviders = {
    async inspect() { fault("inspect"); return inventory; },
    async arm(input) { tickets.set(input.ticketId, { operation: input.operation, issued: false, closed: false, revoked: false }); fault("arm"); },
    async activate(id) { ticket(id); grants.add("c".repeat(32)); fault("activate"); },
    async issue(id) { const value = ticket(id); if (value.issued) throw new Error("duplicate issuance"); value.issued = true; issueCount++; fault("issue");
      return { credentialId: "d".repeat(32), accessKeyId: CANARIES[0]!, secretAccessKey: CANARIES[1]!, bucket: operation.bucket,
        accountId: operation.accountId, jurisdiction: operation.jurisdiction, permission: "Object Read", expiresAt: operation.credentialExpiresAt }; },
    async createOnly(id, name, value) { ticket(id); if (vault.has(name)) throw new Error("collision"); vault.set(name, value); fault(`store:${name}`); },
    async readCreated(id, name) { ticket(id); fault(`read:${name}`); return vault.get(name)!; },
    async cleanup(id, revoke) { fault("cleanup"); const value = tickets.get(id);
      if (value) { value.closed = true; value.revoked ||= revoke; }
      grants.delete("c".repeat(32)); return { grantsRemoved: true, credentialRevoked: !value || value.revoked }; },
  };
  const authority = { async consume() {}, async check() { fault("authority"); await checkHook?.(); return structuredClone(operation); } };
  const createService = () => credentialTransferService({ authority, journal, providers, now: () => clock });
  return { actor, request, operation, rows, snapshots, trace, tickets, vault, grants, journal, providers, authority, inventory,
    createService, get issueCount() { return issueCount; },
    setFailure(step: string | null) { fail = step; }, setCheckHook(hook: typeof checkHook) { checkHook = hook; },
    advance(ms: number) { clock += ms; },
    async sweep() { for (const [id, value] of tickets) if (!value.closed && clock >= Date.parse(value.operation.grantDeadline)) await providers.cleanup(id, true); },
  };
}
