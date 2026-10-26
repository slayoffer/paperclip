import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  createConversationOwnershipReader,
  getConversationOwnershipBlocker,
  getConversationOwnershipBlockerForRead,
} from "./conversation-continuation.js";

function database() {
  const query = vi.fn().mockResolvedValue([]);
  const chain = { from: () => chain, where: () => chain, orderBy: query };
  return { db: { select: () => chain } as unknown as Db, query };
}

afterEach(() => vi.restoreAllMocks());

describe("conversation ownership reads", () => {
  it("shares concurrent checks within one pass and separates issues and companies", async () => {
    const { db, query } = database();
    const read = createConversationOwnershipReader(db);
    await Promise.all([read("company", "issue"), read("company", "issue")]);
    expect(query).toHaveBeenCalledTimes(1);
    await read("other-company", "issue");
    await read("company", "other-issue");
    expect(query).toHaveBeenCalledTimes(3);
    await createConversationOwnershipReader(db)("company", "issue");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("retries a rejected check instead of retaining its rejection", async () => {
    const { db, query } = database();
    query.mockRejectedValueOnce(new Error("connection lost"));
    const read = createConversationOwnershipReader(db);
    await expect(read("company", "issue")).rejects.toThrow("connection lost");
    await expect(read("company", "issue")).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("expires polling results each second and never caches execution admission", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { db, query } = database();
    expect(await getConversationOwnershipBlockerForRead(db, "company", "issue")).toBeNull();
    query.mockResolvedValue([{
      run: { id: "run", agentId: "agent", processPid: null, processGroupId: null },
      activeLease: true,
    }]);
    // An execution boundary must see a lease acquired after the polling read.
    expect(await getConversationOwnershipBlocker(db, "company", "issue")).toMatchObject({
      runId: "run", cause: "execution_owner_active",
    });
    expect(await getConversationOwnershipBlockerForRead(db, "company", "issue")).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(2000);
    expect(await getConversationOwnershipBlockerForRead(db, "company", "issue")).not.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    const other = database();
    await getConversationOwnershipBlockerForRead(other.db, "company", "issue");
    expect(other.query).toHaveBeenCalledTimes(1);
  });
});
