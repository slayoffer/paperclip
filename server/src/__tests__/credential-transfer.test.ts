import { describe, it, expect, vi } from "vitest";
import { transferFixture, CANARIES } from "./helpers/credential-transfer-fixture.js";
import { TRANSFER_NAMES, CredentialTransferError } from "../services/credential-transfer.js";

describe("bounded credential transfer", () => {
  it("creates two entries and removes temporary grants while preserving the baseline", async () => {
    const f = transferFixture();
    const receipt = await f.createService().execute(f.actor, f.request);
    expect(receipt.state).toBe("complete");
    expect(receipt.storedNames).toEqual(TRANSFER_NAMES);
    expect(f.issueCount).toBe(1);
    expect([...f.vault.values()]).toEqual(CANARIES);
    expect([...f.grants]).toEqual(["b".repeat(32)]);
    expect(f.trace.indexOf("arm")).toBeLessThan(f.trace.indexOf("activate"));
  });

  it.each(["arm", "activate", "issue", ...TRANSFER_NAMES.flatMap(name => [`store:${name}`, `read:${name}`])])(
    "revokes after a lost or failed %s response and preserves partial vault entries", async step => {
      const f = transferFixture();
      f.setFailure(step);
      const receipt = await f.createService().execute(f.actor, f.request);
      expect(receipt.state).toBe("revoked");
      expect([...f.tickets.values()].every(t => t.revoked)).toBe(true);
      expect([...f.grants]).toEqual(["b".repeat(32)]);
      const expectedEntries = step.includes(TRANSFER_NAMES[1]) ? 2 : step.includes(TRANSFER_NAMES[0]) ? 1 : 0;
      expect(f.vault.size).toBe(expectedEntries);
      await f.createService().recover(f.actor.companyId);
      expect(f.issueCount).toBeLessThanOrEqual(1);
      expect(f.vault.size).toBe(expectedEntries);
    },
  );

  it.each([
    ["incomplete inventory", (f: ReturnType<typeof transferFixture>) => { f.inventory.complete = false; }],
    ["bucket owner", f => { f.inventory.bucketOwned = false; }],
    ["jurisdiction", f => { f.inventory.jurisdiction = "eu"; }],
    ["shared identity", f => { f.inventory.identityExclusive = false; }],
    ["collision", f => { f.inventory.destinationCount = 1; }],
    ["unsafe removal", f => { f.inventory.safeAutomaticRemoval = false; }],
    ["company", f => { f.operation.companyId = f.request.issueId; }],
    ["actor", f => { f.operation.userId = "other-person"; }],
    ["binding", f => { f.operation.source.connectionVersion = "2025-10-18T12:00:00.000Z"; }],
    ["scope", f => { Object.assign(f.operation, { permission: "Object Write" }); }],
    ["operation kind", f => { f.operation.operation = "r2_permission_window"; }],
    ["expiry", f => { f.operation.credentialExpiresAt = "2027-10-18T12:00:00.000Z"; }],
    ["window", f => { f.operation.grantDeadline = "2026-10-18T13:00:01.000Z"; }],
  ] as const)("rejects invalid %s before activation", async (_name, mutate) => {
    const f = transferFixture();
    // Separate request bindings from the approved document.
    f.operation.source = structuredClone(f.request.source);
    mutate(f);
    await expect(f.createService().execute(f.actor, f.request)).rejects.toBeInstanceOf(CredentialTransferError);
    expect(f.trace).not.toContain("activate");
    expect(f.issueCount).toBe(0);
  });

  it("rejects arbitrary fields without returning secret inputs", async () => {
    const f = transferFixture();
    let error: unknown;
    try { await f.createService().execute(f.actor, { ...f.request, script: CANARIES[0] } as typeof f.request); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CredentialTransferError);
    expect(JSON.stringify(error)).not.toContain(CANARIES[0]);
    expect(f.trace).toEqual([]);
  });

  it.each([
    { label: "permission", patch: { permission: "Object Write" } },
    { label: "bucket", patch: { bucket: "another-bucket" } },
    { label: "jurisdiction", patch: { jurisdiction: "eu" } },
    { label: "expiry", patch: { expiresAt: "2027-10-18T12:00:00.000Z" } },
    { label: "identifier", patch: { credentialId: CANARIES[0]! } },
  ])("revokes an issued credential with an invalid $label", async ({ patch }) => {
    const f = transferFixture();
    const issue = f.providers.issue;
    f.providers.issue = async id => ({ ...await issue(id), ...patch });
    const receipt = await f.createService().execute(f.actor, f.request);
    expect(receipt.state).toBe("revoked");
    expect(f.vault.size).toBe(0);
    expect(f.issueCount).toBe(1);
    expect([...f.tickets.values()].every(ticket => ticket.revoked)).toBe(true);
    for (const canary of CANARIES) expect(JSON.stringify([receipt, [...f.rows.values()]])).not.toContain(canary);
  });

  it("rechecks authority after arming and revokes after authority changes", async () => {
    const f = transferFixture();
    let count = 0;
    f.setCheckHook(() => { if (++count > 1) throw new Error(CANARIES[0]); });
    expect((await f.createService().execute(f.actor, f.request)).state).toBe("revoked");
    expect(f.trace).not.toContain("activate");
  });

  it("does not overwrite a collision that appears after inspection", async () => {
    const f = transferFixture();
    f.vault.set(TRANSFER_NAMES[0], "existing-value");
    expect((await f.createService().execute(f.actor, f.request)).state).toBe("revoked");
    expect(f.vault.get(TRANSFER_NAMES[0])).toBe("existing-value");
  });

  it("prevents concurrent issuance and replay of the same approval", async () => {
    const f = transferFixture();
    const outcomes = await Promise.allSettled([f.createService().execute(f.actor, f.request), f.createService().execute(f.actor, f.request)]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(f.issueCount).toBe(1);
    await expect(f.createService().execute(f.actor, f.request)).rejects.toMatchObject({ details: { code: "approval_already_used" } });
    expect(f.issueCount).toBe(1);
  });

  it("recovers cleanup after restart without issuance or storage", async () => {
    const f = transferFixture();
    f.setFailure("cleanup");
    const receipt = await f.createService().execute(f.actor, f.request);
    expect(receipt.state).toBe("cleanup_required");
    const count = f.issueCount;
    const entries = f.vault.size;
    f.setFailure(null);
    expect((await f.createService().recover(f.actor.companyId))[0]?.state).toBe("revoked");
    expect(f.issueCount).toBe(count);
    expect(f.vault.size).toBe(entries);
    expect([...f.grants]).toEqual(["b".repeat(32)]);
  });

  it("uses the independent deadline across process loss and fences late calls", async () => {
    const f = transferFixture();
    f.setFailure("cleanup");
    await f.createService().execute(f.actor, f.request);
    f.setFailure(null);
    f.advance(3600000);
    await f.sweep();
    expect([...f.grants]).toEqual(["b".repeat(32)]);
    const id = [...f.tickets.keys()][0]!;
    await expect(f.providers.activate(id)).rejects.toThrow();
    await expect(f.providers.issue(id)).rejects.toThrow();
    await f.createService().recover(f.actor.companyId);
    expect(f.issueCount).toBe(1);
  });


  it.each([1, 2, 3, 4, 5, 6])("recovers a journal failure at write %s without repeating issuance", async failAt => {
    const f = transferFixture();
    const save = f.journal.save;
    let count = 0;
    f.journal.save = async row => {
      if (++count === failAt) throw new Error(CANARIES[1]);
      await save(row);
    };
    const receipt = await f.createService().execute(f.actor, f.request);
    expect(receipt.state).toBe("revoked");
    await f.createService().recover(f.actor.companyId);
    expect(f.issueCount).toBeLessThanOrEqual(1);
    expect(f.grants).toEqual(new Set(["b".repeat(32)]));
    for (const canary of CANARIES) expect(JSON.stringify([receipt, [...f.rows.values()]])).not.toContain(canary);
  });

  it("preserves an unrelated grant and the completed credential after the deadline", async () => {
    const f = transferFixture();
    f.grants.add("e".repeat(32));
    const receipt = await f.createService().execute(f.actor, f.request);
    expect(receipt.state).toBe("complete");
    f.advance(3600000);
    await f.sweep();
    expect(f.grants).toEqual(new Set(["b".repeat(32), "e".repeat(32)]));
    expect([...f.tickets.values()].every(ticket => !ticket.revoked)).toBe(true);
  });

  it("rejects mismatched readback and never emits canaries in receipts, journal, metadata, or logs", async () => {
    const f = transferFixture();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    f.providers.readCreated = async () => "wrong-value";
    try {
      const receipt = await f.createService().execute(f.actor, f.request);
      expect(receipt.state).toBe("revoked");
      const observable = JSON.stringify([receipt, [...f.rows.values()], f.snapshots, f.trace, logs.map(log => log.mock.calls)]);
      for (const canary of CANARIES) expect(observable).not.toContain(canary);
    } finally { logs.forEach(log => log.mockRestore()); }
  });
});
