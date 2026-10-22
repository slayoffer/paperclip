import { and, eq, inArray } from "drizzle-orm";
import { credentialTransfers, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { CredentialTransferError, type TransferJournal, type TransferRow } from "./credential-transfer.js";

function values(row: TransferRow) {
  return { id: row.id, ...row.actor, permissionApprovalId: row.bindings.permissionApproval.interactionId,
    issuanceApprovalId: row.bindings.issuanceApproval.interactionId,
    bindings: row.bindings, operation: row.operation, state: row.state,
    baselineGrantIds: row.baselineGrantIds, cleanupTicketId: row.cleanupTicketId,
    credentialId: row.credentialId, storedNames: row.storedNames, failureCode: row.failureCode,
    grantDeadline: new Date(row.operation.grantDeadline), updatedAt: new Date() };
}
function restore(row: typeof credentialTransfers.$inferSelect): TransferRow {
  return { id: row.id, actor: { companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, userId: row.userId },
    bindings: row.bindings, operation: row.operation, state: row.state, baselineGrantIds: row.baselineGrantIds,
    cleanupTicketId: row.cleanupTicketId, credentialId: row.credentialId, storedNames: row.storedNames, failureCode: row.failureCode };
}
export function credentialTransferJournal(db: Db): TransferJournal {
  return {
    exclusive: (companyId, _connectionId, work) => withDedicatedDbConnection(db, async dedicated => {
      // A reserved backend never reconnects after loss. Later queries reject instead.
      const backend = await dedicated.$client.reserve();
      const key = `credential-transfer:${companyId}`;
      let acquired = false;
      const assertHeld = async () => {
        try {
          const [lock] = await backend`select exists (
            select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
              and classid = (hashtextextended(${key}, 0) >> 32)::int::oid
              and objid = (hashtextextended(${key}, 0) & 4294967295)::oid and objsubid = 1 and granted
          ) as held`;
          if (!lock?.held) throw new Error("lock_lost");
        } catch {
          throw new CredentialTransferError(409, "transfer_lock_lost");
        }
      };
      try {
        const [lock] = await backend`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`;
        acquired = lock?.acquired === true;
        if (!acquired) throw new CredentialTransferError(409, "transfer_busy");
        const result = await work(assertHeld);
        await assertHeld();
        return result;
      } finally {
        try {
          if (acquired) await backend`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
        } catch { /* Backend loss already releases its lock. Never reconnect to unlock. */ }
        backend.release();
      }
    }),
    async insert(row) {
      const inserted = await db.insert(credentialTransfers).values(values(row)).onConflictDoNothing().returning({ id: credentialTransfers.id });
      if (!inserted.length) throw new CredentialTransferError(409, "approval_already_used");
    },
    async save(row) {
      const updated = await db.update(credentialTransfers).set(values(row)).where(and(
        eq(credentialTransfers.companyId, row.actor.companyId), eq(credentialTransfers.id, row.id),
      )).returning({ id: credentialTransfers.id });
      if (!updated.length) throw new CredentialTransferError(409, "journal_unavailable");
    },
    async get(companyId, id) {
      const [row] = await db.select().from(credentialTransfers).where(and(eq(credentialTransfers.companyId, companyId), eq(credentialTransfers.id, id)));
      return row ? restore(row) : null;
    },
    async unfinished(companyId) {
      return (await db.select().from(credentialTransfers).where(and(eq(credentialTransfers.companyId, companyId),
        inArray(credentialTransfers.state, ["prepared", "armed", "issuing", "storing", "cleanup_required"])))).map(restore);
    },
  };
}
