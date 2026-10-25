import { eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { readBatchedAgent } from "./agent-read-batch.js";

type Row = typeof agents.$inferSelect;
export function createAgentReadById<T extends { id: string }>(db: Db, options: {
  listCompanyAgentRows: (companyId: string) => Promise<Row[]>;
  hydrateAgentSpend: (rows: Row[]) => Promise<Row[]>;
  normalizeAgentRows: (rows: Row[], allCompanyRows: Row[]) => T[];
}) {
  const { listCompanyAgentRows, hydrateAgentSpend, normalizeAgentRows } = options;
  return async (id: string): Promise<T | null> => {
    const batched = await readBatchedAgent(db, id, async (companyId) => {
      const rows = await listCompanyAgentRows(companyId);
      return normalizeAgentRows(await hydrateAgentSpend(rows), rows);
    });
    if (batched) return batched.row;
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    if (!row) return null;
    const [companyRows, hydrated] = await Promise.all([
      listCompanyAgentRows(row.companyId), hydrateAgentSpend([row]),
    ]);
    return normalizeAgentRows(hydrated, companyRows)[0]!;
  };
}
