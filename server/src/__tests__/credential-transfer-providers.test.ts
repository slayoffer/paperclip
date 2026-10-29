import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { credentialTransferService, TRANSFER_NAMES, type TransferAuthority } from "../services/credential-transfer.js";
import { credentialFingerprint, credentialTransferProviders, r2BucketResource, R2_OBJECT_READ_PERMISSION_GROUP_ID } from "../services/credential-transfer-providers.js";
import type { CleanupContract } from "../services/credential-transfer-cleanup.js";
import { transferFixture } from "./helpers/credential-transfer-fixture.js";
import { ERROR_CANARY, providerFakes, SIMULATED_CONTRACT, TOKEN_CANARY } from "./helpers/credential-transfer-provider-fakes.js";

const DERIVED_SECRET = createHash("sha256").update(TOKEN_CANARY).digest("hex");

function setup(contract: CleanupContract = SIMULATED_CONTRACT) {
  const f = transferFixture();
  let clock = Date.parse("2026-10-18T12:00:00.000Z");
  const now = () => clock;
  const p = providerFakes(now);
  const gatewayArgs: unknown[] = [];
  let clientLoads = 0;
  // Record every argument that would reach the tool gateway.
  const authority: TransferAuthority = {
    check: async (...args) => { gatewayArgs.push(args); return f.authority.check(); },
    consume: async (...args) => { gatewayArgs.push(args); },
  };
  const adapter = () => credentialTransferProviders({ contract, now, clients: async () => { clientLoads++; return p.clients; } });
  const service = (providers = adapter()) => credentialTransferService({ authority, journal: f.journal, providers, now });
  return { f, p, now, adapter, service, gatewayArgs, get clientLoads() { return clientLoads; },
    advance(ms: number) { clock += ms; }, run: () => service().execute(f.actor, f.request) };
}
const tokenIds = (s: ReturnType<typeof setup>) => [...s.p.tokens.keys()];

describe("credential transfer production adapter with simulated providers", () => {
  it("stores both derived values, removes temporary grants, and preserves both baselines", async () => {
    const s = setup();
    const receipt = await s.run();
    expect(receipt.state).toBe("complete");
    const [tokenId] = tokenIds(s);
    expect(s.p.tokens.size).toBe(1);
    expect(s.p.secrets.get(TRANSFER_NAMES[0])).toBe(tokenId);
    expect(s.p.secrets.get(TRANSFER_NAMES[1])).toBe(DERIVED_SECRET);
    expect(receipt.credentialId).toBe(credentialFingerprint(tokenId!));
    expect(s.p.temporaryGrants()).toEqual([]);
    expect([...s.p.grants.keys()].sort()).toEqual([...s.p.baseline].sort());
    expect(s.p.activeTokens()).toHaveLength(1);
    const token = s.p.tokens.get(tokenId!)!;
    expect(token.policies).toEqual([{ effect: "allow", resources: { [r2BucketResource(s.f.operation)]: "*" },
      permissionGroups: [{ id: R2_OBJECT_READ_PERMISSION_GROUP_ID }] }]);
    expect(token.expiresOn).toBe(s.f.operation.credentialExpiresAt);
    expect(s.p.trace.indexOf("register")).toBeLessThan(s.p.trace.indexOf("r2.activate"));
    expect(s.p.trace.indexOf("close")).toBeLessThan(s.p.trace.indexOf("removeGrant"));
  });

  it.each<[CleanupContract]>([[{}], ...Object.keys(SIMULATED_CONTRACT).map(key => [{ ...SIMULATED_CONTRACT, [key]: undefined }] as [CleanupContract])])(
    "refuses an unqualified contract before credential reads or provider calls (%#)", async contract => {
      const s = setup(contract);
      await expect(s.run()).rejects.toMatchObject({ status: 422, details: { code: "provider_guarantees_unqualified" } });
      expect(s.clientLoads).toBe(0);
      expect(s.p.trace).toEqual([]);
      expect(s.f.rows.size).toBe(0);
    });

  it.each([
    ["wrong account", (p: ReturnType<typeof providerFakes>) => { p.r2Inventory.bucket = { ...p.r2Inventory.bucket!, accountId: "f".repeat(32) }; }],
    ["wrong bucket", p => { p.r2Inventory.bucket = { ...p.r2Inventory.bucket!, name: "another-bucket" }; }],
    ["missing bucket", p => { p.r2Inventory.bucket = null; }],
    ["wrong jurisdiction", p => { p.r2Inventory.bucket = { ...p.r2Inventory.bucket!, jurisdiction: "eu" }; }],
    ["incomplete inventory", p => { p.r2Inventory.complete = false; }],
    ["incomplete vault inventory", p => { p.vaultInventory.complete = false; }],
    ["denied source access", p => { p.r2Inventory.accessDenied = true; }],
    ["denied destination access", p => { p.vaultInventory.accessDenied = true; }],
    ["shared source identity", p => { p.r2Inventory.principalExclusive = false; }],
    ["shared destination identity", p => { p.vaultInventory.principalExclusive = false; }],
    ["unknown principal", p => { p.vaultInventory.principalId = ""; }],
    ["permission group", p => { p.r2Inventory.permissionGroups = { [R2_OBJECT_READ_PERMISSION_GROUP_ID]: "Workers R2 Storage Write" }; }],
    ["destination collision", p => { p.secrets.set(TRANSFER_NAMES[1], "existing-entry"); }],
    ["invalid baseline", p => { p.grants.set("not-a-grant", { ticketId: null, side: "r2" }); }],
  ] as const)("rejects %s before activation", async (_name, mutate) => {
    const s = setup();
    mutate(s.p);
    await expect(s.run()).rejects.toMatchObject({ status: 422 });
    expect(s.p.trace).not.toContain("register");
    expect(s.p.temporaryGrants()).toEqual([]);
    expect(s.p.tokens.size).toBe(0);
    expect(s.p.secrets.get(TRANSFER_NAMES[1]) ?? "existing-entry").toBe("existing-entry");
  });

  it.each([
    ["register", "lost", 0], ["register", "before", 0], ["r2.activate", "lost", 0], ["vault.activate", "lost", 0],
    ["createToken", "lost", 0], ["createToken", "before", 0],
    [`createOnly:${TRANSFER_NAMES[0]}`, "lost", 1], [`createOnly:${TRANSFER_NAMES[1]}`, "before", 1],
    [`createOnly:${TRANSFER_NAMES[1]}`, "lost", 2], [`readCreated:${TRANSFER_NAMES[0]}`, "lost", 1],
    [`readCreated:${TRANSFER_NAMES[1]}`, "lost", 2],
  ] as const)("cleans up after a %s failure (%s) and preserves %s partial entries", async (step, fault, entries) => {
    const s = setup();
    s.p.fail(step, fault);
    const receipt = await s.run();
    expect(receipt.state).toBe("revoked");
    expect(s.p.temporaryGrants()).toEqual([]);
    expect([...s.p.grants.keys()].sort()).toEqual([...s.p.baseline].sort());
    expect(s.p.activeTokens()).toEqual([]);
    expect(s.p.tokens.size).toBeLessThanOrEqual(1);
    expect(s.p.secrets.size).toBe(entries);
    s.p.fail(step, null);
    await s.service().recover(s.f.actor.companyId);
    expect(s.p.tokens.size).toBeLessThanOrEqual(1);
    expect(s.p.secrets.size).toBe(entries);
  });

  it("resolves a lost issuance after restart from provider ownership and never issues again", async () => {
    const s = setup();
    s.p.fail("createToken", "lost");
    s.p.fail("removeGrant", "before");
    expect((await s.run()).state).toBe("cleanup_required");
    expect(s.p.activeTokens()).toHaveLength(1);
    s.p.fail("removeGrant", null);
    // A new adapter instance has no process memory of the ticket.
    const [receipt] = await s.service(s.adapter()).recover(s.f.actor.companyId);
    expect(receipt?.state).toBe("revoked");
    expect(s.p.tokens.size).toBe(1);
    expect(s.p.activeTokens()).toEqual([]);
    expect(s.p.temporaryGrants()).toEqual([]);
    await expect(s.run()).rejects.toMatchObject({ details: { code: "approval_already_used" } });
    expect(s.p.tokens.size).toBe(1);
  });

  it("refuses issuance when the provider already accepted a request for the ticket", async () => {
    const s = setup();
    const adapter = s.adapter();
    const ticketId = randomUUID();
    await adapter.arm({ ticketId, transferId: randomUUID(), operation: s.f.operation, baselineGrantIds: s.p.baseline });
    s.p.tickets.get(ticketId)!.issuanceAccepted = true;
    await expect(adapter.issue(ticketId)).rejects.toMatchObject({ details: { code: "issuance_already_accepted" } });
    expect(s.p.tokens.size).toBe(0);
  });

  it.each(["vault.activate", "createToken", `createOnly:${TRANSFER_NAMES[0]}`])(
    "fences a late %s effect after cleanup closes the ticket", async step => {
      const s = setup();
      s.p.fail(step, "delayed");
      expect((await s.run()).state).toBe("revoked");
      s.p.applyDelayed();
      expect(s.p.fenced).toBe(1);
      expect(s.p.temporaryGrants()).toEqual([]);
      expect(s.p.activeTokens()).toEqual([]);
      expect(s.p.tokens.size).toBe(step.startsWith("createOnly") ? 1 : 0);
      expect(s.p.secrets.size).toBe(0);
    });

  it("stops dispatch when the remaining window cannot hold the worst-case bound", async () => {
    const s = setup();
    const activate = s.p.clients.r2.activate;
    s.p.clients.r2.activate = async input => { await activate(input); s.advance(56 * 60 * 1000); };
    expect((await s.run()).state).toBe("revoked");
    expect(s.p.trace).not.toContain("vault.activate");
    expect(s.p.tokens.size).toBe(0);
    expect(s.p.temporaryGrants()).toEqual([]);
  });

  it("removes grants through provider expiry across process loss and fences later calls", async () => {
    const s = setup();
    s.p.fail("createToken", "lost");
    s.p.fail("close", "before");
    expect((await s.run()).state).toBe("cleanup_required");
    expect(s.p.temporaryGrants()).toHaveLength(2);
    s.advance(60 * 60 * 1000);
    s.p.providerExpiry();
    expect(s.p.temporaryGrants()).toEqual([]);
    const ticketId = [...s.p.tickets.keys()][0]!;
    await expect(s.p.clients.r2.activate({ ticketId, accountId: s.f.operation.accountId, deadline: s.f.operation.grantDeadline })).rejects.toThrow();
    await expect(s.p.clients.vault.createOnly({ ticketId, project: "synthiq-infra", environment: "prod", path: "/clpn-ha",
      name: TRANSFER_NAMES[0], value: "late" })).rejects.toThrow();
    s.p.fail("close", null);
    expect((await s.service(s.adapter()).recover(s.f.actor.companyId))[0]?.state).toBe("revoked");
    expect(s.p.activeTokens()).toEqual([]);
    expect(s.p.secrets.size).toBe(0);
  });

  it("permits one executor and one issuance under concurrent requests", async () => {
    const s = setup();
    const outcomes = await Promise.allSettled([s.run(), s.run()]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect(s.p.tokens.size).toBe(1);
  });

  it("keeps canaries out of logs, receipts, errors, journal rows, gateway arguments, and provider metadata calls", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const ok = setup();
      const receipts: unknown[] = [await ok.run()];
      const failed = setup();
      failed.p.fail(`createOnly:${TRANSFER_NAMES[1]}`, "lost");
      receipts.push(await failed.run());
      const refused = setup();
      refused.p.r2Inventory.complete = false;
      const error = await refused.run().catch((e: unknown) => e);
      const tokenId = tokenIds(ok)[0]!;
      const observable = JSON.stringify([receipts, error, String(error), [...ok.f.rows.values()], [...failed.f.rows.values()],
        ok.f.snapshots, failed.f.snapshots, ok.gatewayArgs, failed.gatewayArgs, ok.p.external, failed.p.external,
        logs.map(log => log.mock.calls)]);
      for (const canary of [TOKEN_CANARY, DERIVED_SECRET, tokenId, ERROR_CANARY]) expect(observable).not.toContain(canary);
    } finally { logs.forEach(log => log.mockRestore()); }
  });
});
