import { randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CreateCredentialTransfer, CredentialTransferOperation } from "@paperclipai/shared";
import { createCredentialTransferSchema, credentialTransferOperationSchema } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

export const TRANSFER_NAMES = ["CLPN_R2_MONITOR_ACCESS_KEY_ID", "CLPN_R2_MONITOR_SECRET_ACCESS_KEY"] as const;
export type TransferActor = { companyId: string; issueId: string; agentId: string; userId: string };
export type TransferRow = {
  id: string;
  actor: TransferActor;
  bindings: CreateCredentialTransfer;
  operation: CredentialTransferOperation;
  state: "prepared" | "armed" | "issuing" | "storing" | "complete" | "revoked" | "cleanup_required";
  baselineGrantIds: string[];
  cleanupTicketId: string | null;
  credentialId: string | null;
  storedNames: string[];
  failureCode: string | null;
};
export interface TransferJournal {
  /** Company-wide cross-process lock. A competing executor fails without waiting or lease theft. */
  exclusive<T>(companyId: string, destinationConnectionId: string, work: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T>;
  insert(row: TransferRow): Promise<void>;
  save(row: TransferRow): Promise<void>;
  get(companyId: string, id: string): Promise<TransferRow | null>;
  unfinished(companyId: string): Promise<TransferRow[]>;
}
export type TransferProviderOperation = "inspect" | "arm" | "activate" | "issue" | "createOnly" | "readCreated";
export interface TransferAuthority {
  /** Reload both human approvals, current document revisions, ownership, and gateway policy. */
  check(actor: TransferActor, refs: CreateCredentialTransfer): Promise<CredentialTransferOperation>;
  /** Charge the server-owned tool mapping once, immediately before each provider operation. */
  consume(actor: TransferActor, refs: CreateCredentialTransfer, effect: TransferProviderOperation, expected: CredentialTransferOperation): Promise<void>;
}
export interface TransferProviders {
  /** Metadata only. Inventory must include all pages and all effective permissions. */
  inspect(operation: CredentialTransferOperation): Promise<{
    complete: boolean;
    accountId: string;
    bucket: string;
    jurisdiction: string;
    bucketOwned: boolean;
    identityExclusive: boolean;
    effectivePermission: "Object Read";
    baselineGrantIds: string[];
    destinationCount: number;
    safeAutomaticRemoval: boolean;
  }>;
  /** Before activation, arm an independent durable deadline. Use the client-generated ticket ID.
   * On lost responses, cleanup(ticketId) must work. Remove only grants created by this ticket.
   * Preserve every baseline grant and every unrelated grant.
   * The ticket fences late calls and tracks issuance by transferId, even if its reply is lost.
   * An adapter that cannot guarantee these properties must reject before activation.
   */
  arm(input: { ticketId: string; transferId: string; operation: CredentialTransferOperation; baselineGrantIds: string[] }): Promise<void>;
  activate(ticketId: string): Promise<void>;
  /** Exactly once. Never retry issuance. The durable ticket records the new provider identifier. */
  issue(ticketId: string): Promise<{
    credentialId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    accountId: string;
    jurisdiction: string;
    permission: string;
    expiresAt: string;
  }>;
  /** Direct in-process vault call. No tool gateway, command, log, overwrite, or retry path. */
  createOnly(ticketId: string, name: typeof TRANSFER_NAMES[number], value: string): Promise<void>;
  readCreated(ticketId: string, name: typeof TRANSFER_NAMES[number]): Promise<string>;
  /** Idempotent, durable cleanup. Revoke only this ticket's new credential on failure.
   * Preserve baseline grants and all vault entries. Fence late activation, issuance and storage.
   * Resolve ambiguous issuance from the ticket. Never issue another credential.
   */
  cleanup(ticketId: string, revokeCredential: boolean): Promise<{ grantsRemoved: boolean; credentialRevoked: boolean }>;
}

export class CredentialTransferError extends HttpError {
  constructor(status: number, code: string) {
    super(status, "The credential transfer cannot continue.", { code });
  }
}
function requireCondition(ok: unknown, code: string): asserts ok {
  if (!ok) throw new CredentialTransferError(422, code);
}
function equalSecret(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function transferReceipt(row: TransferRow) {
  return { id: row.id, state: row.state, credentialId: row.credentialId,
    storedNames: [...row.storedNames], failureCode: row.failureCode };
}

export function credentialTransferService(deps: {
  authority: TransferAuthority;
  journal: TransferJournal;
  providers: TransferProviders;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  function validateOperation(actor: TransferActor, request: CreateCredentialTransfer, value: CredentialTransferOperation) {
    const parsed = credentialTransferOperationSchema.safeParse(value);
    requireCondition(parsed.success, "operation_invalid");
    const operation = parsed.data;
    requireCondition(operation.operation === "r2_credential_transfer", "operation_invalid");
    requireCondition(operation.companyId === actor.companyId && operation.issueId === actor.issueId
      && operation.agentId === actor.agentId && operation.userId === actor.userId
      && request.issueId === actor.issueId, "actor_mismatch");
    requireCondition(isDeepStrictEqual(request.source, operation.source)
      && isDeepStrictEqual(request.destination, operation.destination)
      && request.source.connectionId !== request.destination.connectionId, "binding_changed");
    requireCondition(Date.parse(operation.credentialExpiresAt) > now()
      && Date.parse(operation.credentialExpiresAt) - now() <= 90 * 24 * 60 * 60 * 1000, "expiry_invalid");
    requireCondition(Date.parse(operation.grantDeadline) > now()
      && Date.parse(operation.grantDeadline) - now() <= 60 * 60 * 1000
      && Date.parse(operation.executionDeadline) > now()
      && Date.parse(operation.executionDeadline) <= Date.parse(operation.grantDeadline), "window_invalid");
    return operation;
  }
  async function recheck(row: TransferRow) {
    const operation = validateOperation(row.actor, row.bindings, await deps.authority.check(row.actor, row.bindings));
    requireCondition(isDeepStrictEqual(operation, row.operation), "approval_changed");
  }
  async function clean(row: TransferRow, revoke: boolean) {
    if (!row.cleanupTicketId) return;
    const result = await deps.providers.cleanup(row.cleanupTicketId, revoke);
    requireCondition(result.grantsRemoved && (!revoke || result.credentialRevoked), "cleanup_incomplete");
  }
  return {
    async execute(actor: TransferActor, input: CreateCredentialTransfer) {
      // Never return Zod input values or provider exception objects through the API.
      const parsed = createCredentialTransferSchema.safeParse(input);
      requireCondition(parsed.success, "request_invalid");
      const request = parsed.data;
      try {
        return await deps.journal.exclusive(actor.companyId, request.destination.connectionId, async assertHeld => {
          const operation = validateOperation(actor, request, await deps.authority.check(actor, request));
          await assertHeld();
          await deps.authority.consume(actor, request, "inspect", operation);
          await assertHeld();
          const inventory = await deps.providers.inspect(operation);
          requireCondition(inventory.complete && inventory.bucketOwned && inventory.identityExclusive
            && inventory.accountId === operation.accountId && inventory.bucket === operation.bucket
            && inventory.jurisdiction === operation.jurisdiction
            && inventory.effectivePermission === "Object Read", "inventory_invalid");
          requireCondition(inventory.destinationCount === 0, "destination_collision");
          requireCondition(inventory.safeAutomaticRemoval, "automatic_removal_unavailable");
          requireCondition(inventory.baselineGrantIds.every(id => /^[a-f0-9]{32}$/.test(id)), "baseline_invalid");
          const row: TransferRow = { id: randomUUID(), actor: { ...actor }, bindings: request, operation,
            state: "prepared", baselineGrantIds: [...inventory.baselineGrantIds], cleanupTicketId: null,
            credentialId: null, storedNames: [], failureCode: null };
          await deps.journal.insert(row);
          try {
            // Persist a known ticket before arming. A lost arm reply remains recoverable.
            row.cleanupTicketId = randomUUID();
            row.state = "armed";
            await deps.journal.save(row);
            await recheck(row);
            await assertHeld();
            await deps.authority.consume(actor, request, "arm", operation);
            await assertHeld();
            await deps.providers.arm({ ticketId: row.cleanupTicketId, transferId: row.id, operation,
              baselineGrantIds: row.baselineGrantIds });
            await recheck(row);
            await assertHeld();
            await deps.authority.consume(actor, request, "activate", operation);
            await assertHeld();
            await deps.providers.activate(row.cleanupTicketId);
            await recheck(row);
            row.state = "issuing";
            await deps.journal.save(row);
            await assertHeld();
            await deps.authority.consume(actor, request, "issue", operation);
            await assertHeld();
            const issued = await deps.providers.issue(row.cleanupTicketId);
            requireCondition(/^[a-f0-9]{32}$/.test(issued.credentialId), "credential_identifier_invalid");
            row.credentialId = issued.credentialId;
            row.state = "storing";
            await deps.journal.save(row);
            requireCondition(issued.bucket === operation.bucket && issued.accountId === operation.accountId
              && issued.jurisdiction === operation.jurisdiction && issued.permission === "Object Read"
              && issued.expiresAt === operation.credentialExpiresAt
              && typeof issued.accessKeyId === "string" && issued.accessKeyId.length > 0
              && typeof issued.secretAccessKey === "string" && issued.secretAccessKey.length > 0, "issued_scope_invalid");
            const values = [issued.accessKeyId, issued.secretAccessKey];
            for (const [index, name] of TRANSFER_NAMES.entries()) {
              await recheck(row);
              await assertHeld();
              await deps.authority.consume(actor, request, "createOnly", operation);
              await assertHeld();
              await deps.providers.createOnly(row.cleanupTicketId, name, values[index]!);
              row.storedNames.push(name);
              await deps.journal.save(row);
              await recheck(row);
              await assertHeld();
              await deps.authority.consume(actor, request, "readCreated", operation);
              await assertHeld();
              requireCondition(equalSecret(values[index]!, await deps.providers.readCreated(row.cleanupTicketId, name)), "storage_mismatch");
            }
            await recheck(row);
            await assertHeld();
            await clean(row, false);
            row.state = "complete";
            await deps.journal.save(row);
            return transferReceipt(row);
          } catch {
            // Provider errors can contain secrets. Do not retain their message, cause or stack.
            row.failureCode = "execution_failed";
            row.state = "cleanup_required";
            try { await deps.journal.save(row); } catch { /* The pre-effect ticket remains durable. */ }
            try {
              await clean(row, true);
              row.state = "revoked";
              await deps.journal.save(row);
            } catch { /* The independent provider deadline remains active. Recovery retries cleanup only. */ }
            return transferReceipt(row);
          }
        });
      } catch (error) {
        if (error instanceof CredentialTransferError) throw error;
        throw new CredentialTransferError(409, "transfer_unavailable");
      }
    },
    async recover(companyId: string) {
      const receipts: ReturnType<typeof transferReceipt>[] = [];
      for (const candidate of await deps.journal.unfinished(companyId)) {
        await deps.journal.exclusive(companyId, candidate.bindings.destination.connectionId, async assertHeld => {
          await assertHeld();
          const row = await deps.journal.get(companyId, candidate.id);
          if (!row || ["complete", "revoked"].includes(row.state)) return;
          // Recovery never reads a secret or repeats issuance/storage. The provider ticket fences late work.
          row.state = "cleanup_required";
          row.failureCode = "execution_interrupted";
          await deps.journal.save(row);
          try {
            await clean(row, true);
            row.state = "revoked";
            await deps.journal.save(row);
          } catch { /* Keep the fixed cleanup state. Do not retain the provider error. */ }
          receipts.push(transferReceipt(row));
        });
      }
      return receipts;
    },
  };
}
