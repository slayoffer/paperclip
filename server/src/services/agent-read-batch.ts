import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "@paperclipai/db";

type Batch = { db: Db; companyId: string; active: boolean; rows?: Promise<unknown[]> };
const batches = new AsyncLocalStorage<Batch>();

export function withCompanyAgentReadBatch<T>(db: Db, companyId: string, read: () => Promise<T>) {
  const batch: Batch = { db, companyId, active: true };
  return batches.run(batch, async () => {
    try { return await read(); }
    finally { batch.active = false; batch.rows = undefined; }
  });
}

export async function readBatchedAgent<T extends { id: string }>(
  db: Db, id: string, load: (companyId: string) => Promise<T[]>,
): Promise<{ row: T | null } | null> {
  const batch = batches.getStore();
  if (!batch?.active || batch.db !== db) return null;
  batch.rows ??= load(batch.companyId);
  const rows = await batch.rows as T[];
  return { row: rows.find((row) => row.id === id) ?? null };
}
