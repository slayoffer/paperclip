import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { readBatchedAgent, withCompanyAgentReadBatch } from "./agent-read-batch.js";

describe("request-local agent reads", () => {
  const db = {} as Db;
  it("loads one batch for serial and parallel lookups", async () => {
    const load = vi.fn(async () => [{ id: "one" }, { id: "two" }]);
    await withCompanyAgentReadBatch(db, "company", async () => {
      expect(await readBatchedAgent(db, "one", load)).toEqual({ row: { id: "one" } });
      expect(await Promise.all([readBatchedAgent(db, "two", load), readBatchedAgent(db, "missing", load)]))
        .toEqual([{ row: { id: "two" } }, { row: null }]);
    });
    expect(load).toHaveBeenCalledExactlyOnceWith("company");
    expect(await readBatchedAgent(db, "one", load)).toBeNull();
  });

  it("isolates companies and database transactions", async () => {
    const otherDb = {} as Db;
    const load = vi.fn(async (company: string) => [{ id: company }]);
    const results = await Promise.all(["one", "two"].map((company) =>
      withCompanyAgentReadBatch(db, company, async () => {
        expect(await readBatchedAgent(otherDb, company, load)).toBeNull();
        return readBatchedAgent(db, company, load);
      }),
    ));
    expect(results).toEqual([{ row: { id: "one" } }, { row: { id: "two" } }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates database errors without an empty fallback", async () => {
    const load = vi.fn(async () => { throw new Error("database unavailable"); });
    await expect(withCompanyAgentReadBatch(db, "company", () => readBatchedAgent(db, "one", load)))
      .rejects.toThrow("database unavailable");
  });
});
