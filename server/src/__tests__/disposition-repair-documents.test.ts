import { describe, expect, it } from "vitest";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.ts";

// Minimal stand-in for the drizzle builder: each select() chain resolves to the next row set, in call order.
function fakeDb(rowSets: unknown[][]) {
  let call = 0;
  const builder = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return chain;
  };
  return { select: () => builder(rowSets[call++] ?? []) } as never;
}

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  status: "in_progress",
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  executionPolicy: null,
  executionState: null,
  monitorNextCheckAt: null,
} as never;

// Order matches collectDispositionRepairSourceState: blockers, children, interactions, approvals, work products,
// active runs, queued wakes, documents.
const withDocRevision = (revision: number) => [[], [], [], [], [], [], [], [{ id: "doc-1", key: "plan", latestRevisionNumber: revision }]];

describe("disposition repair fingerprint and documents", () => {
  it("changes when an issue document gets a new revision", async () => {
    const before = await collectDispositionRepairSourceState(fakeDb(withDocRevision(1)), { issue });
    const after = await collectDispositionRepairSourceState(fakeDb(withDocRevision(2)), { issue });
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });

  it("stays the same when nothing changed", async () => {
    const a = await collectDispositionRepairSourceState(fakeDb(withDocRevision(3)), { issue });
    const b = await collectDispositionRepairSourceState(fakeDb(withDocRevision(3)), { issue });
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
