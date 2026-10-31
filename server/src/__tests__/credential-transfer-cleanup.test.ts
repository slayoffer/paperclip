import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRANT_WINDOW_MS, qualifyCleanupContract, transferCleanup, UNQUALIFIED_CLEANUP_CONTRACT,
  type CleanupContract, type CleanupController, type TicketEffects,
} from "../services/credential-transfer-cleanup.js";
import { transferFixture } from "./helpers/credential-transfer-fixture.js";
import { SIMULATED_CONTRACT } from "./helpers/credential-transfer-provider-fakes.js";

const GAPS: Record<keyof typeof SIMULATED_CONTRACT, string> = {
  sourceGrantExpiry: "G1", destinationGrantExpiry: "G2", completeInventory: "G3", issuanceOwnership: "G4",
  lateEffectFence: "G5", recovery: "G6", clockUncertainty: "G6", coordination: "G6", scopedRemoval: "G7",
};

/** A scripted controller. Each test sets the provider evidence that `effects` reports. */
function controller(initial: Partial<TicketEffects> = {}) {
  const calls: string[] = [];
  let state: TicketEffects = { settled: true, baselineGrantIds: ["b".repeat(32)], grantIds: [], credentialIds: [],
    issuanceAccepted: false, ...initial };
  const fake: CleanupController = {
    async register(input) { calls.push(`register:${input.deadline}:${input.baselineGrantIds.join(",")}`); },
    async close() { calls.push("close"); },
    async effects() { calls.push("effects"); return structuredClone(state); },
    async removeGrant(_ticket, id) { calls.push(`remove:${id}`); state = { ...state, grantIds: state.grantIds.filter(g => g !== id) }; },
    async revokeCredential(_ticket, id) { calls.push(`revoke:${id}`); state = { ...state, credentialIds: state.credentialIds.filter(c => c !== id) }; },
  };
  return { fake, calls, set(patch: Partial<TicketEffects>) { state = { ...state, ...patch }; } };
}

describe("credential transfer cleanup contract", () => {
  it("reports every gap for the production default and sums the worst-case budget when qualified", () => {
    expect(qualifyCleanupContract(UNQUALIFIED_CLEANUP_CONTRACT)).toEqual({ qualified: false,
      missing: ["G1", "G2", "G3", "G4", "G5", "G6", "G7"] });
    // S + R + max(G1, G2, G4) + C + Q = 5 x 60 seconds.
    expect(qualifyCleanupContract(SIMULATED_CONTRACT)).toEqual({ qualified: true, budgetMs: 300_000, missing: [] });
  });

  it.each(Object.entries(GAPS))("treats a missing %s guarantee as gap %s", (key, gap) => {
    expect(qualifyCleanupContract({ ...SIMULATED_CONTRACT, [key]: undefined })).toEqual({ qualified: false, missing: [gap] });
  });

  it.each([
    ["empty evidence", { evidence: " ", maxDelaySeconds: 1 }],
    ["negative bound", { evidence: "record", maxDelaySeconds: -1 }],
    ["fractional bound", { evidence: "record", maxDelaySeconds: 0.5 }],
    ["unknown bound", { evidence: "record", maxDelaySeconds: Number.NaN }],
  ])("rejects a guarantee with %s", (_name, bound) => {
    expect(qualifyCleanupContract({ ...SIMULATED_CONTRACT, lateEffectFence: bound }).qualified).toBe(false);
  });

  it("rejects a total bound that does not fit inside the 60-minute window", () => {
    const slow = { evidence: "record", maxDelaySeconds: GRANT_WINDOW_MS / 1000 };
    expect(qualifyCleanupContract({ ...SIMULATED_CONTRACT, recovery: slow })).toEqual({ qualified: false, missing: ["G6"] });
  });

  it("refuses to arm without qualification, with a long window, or without room for the budget", async () => {
    const f = transferFixture();
    const at = Date.parse("2026-10-18T12:00:00.000Z");
    const c = controller();
    const arm = (contract: CleanupContract = SIMULATED_CONTRACT, now = at, grantDeadline = f.operation.grantDeadline) =>
      transferCleanup({ controller: c.fake, contract, now: () => now }).arm({ ticketId: randomUUID(), transferId: randomUUID(),
        operation: { ...f.operation, grantDeadline }, baselineGrantIds: ["b".repeat(32)] });
    await expect(arm(UNQUALIFIED_CLEANUP_CONTRACT)).rejects.toMatchObject({ details: { code: "provider_guarantees_unqualified" } });
    await expect(arm(SIMULATED_CONTRACT, at, new Date(at + GRANT_WINDOW_MS + 1).toISOString()))
      .rejects.toMatchObject({ details: { code: "cleanup_window_insufficient" } });
    await expect(arm(SIMULATED_CONTRACT, at + GRANT_WINDOW_MS - 299_000))
      .rejects.toMatchObject({ details: { code: "cleanup_window_insufficient" } });
    expect(c.calls).toEqual([]);
    await arm();
    expect(c.calls).toEqual([`register:${f.operation.grantDeadline}:${"b".repeat(32)}`]);
  });

  it("closes dispatch once the remaining window cannot hold the budget", () => {
    const f = transferFixture();
    const operation = { ...f.operation, executionDeadline: f.operation.grantDeadline };
    let now = Date.parse(operation.grantDeadline) - 300_000;
    const cleanup = transferCleanup({ controller: controller().fake, contract: SIMULATED_CONTRACT, now: () => now });
    expect(() => cleanup.admit(operation)).not.toThrow();
    now += 1;
    expect(() => cleanup.admit(operation)).toThrow(expect.objectContaining({ details: { code: "dispatch_window_closed" } }));
  });

  it("closes first, removes only ticket grants, revokes only the ticket credential, and is idempotent", async () => {
    const c = controller({ grantIds: ["c".repeat(32), "e".repeat(32)], credentialIds: ["d".repeat(32)] });
    const cleanup = transferCleanup({ controller: c.fake, contract: SIMULATED_CONTRACT });
    expect(await cleanup.cleanup(randomUUID(), true)).toEqual({ grantsRemoved: true, credentialRevoked: true });
    expect(c.calls).toEqual(["close", "effects", `remove:${"c".repeat(32)}`, `remove:${"e".repeat(32)}`,
      `revoke:${"d".repeat(32)}`, "effects"]);
    expect(await cleanup.cleanup(randomUUID(), true)).toEqual({ grantsRemoved: true, credentialRevoked: true });
  });

  it("keeps the stored credential after success", async () => {
    const c = controller({ grantIds: ["c".repeat(32)], credentialIds: ["d".repeat(32)] });
    const result = await transferCleanup({ controller: c.fake, contract: SIMULATED_CONTRACT }).cleanup(randomUUID(), false);
    expect(result.grantsRemoved).toBe(true);
    expect(c.calls).not.toContain(`revoke:${"d".repeat(32)}`);
  });

  it.each([
    ["an unsettled request", { settled: false, grantIds: ["c".repeat(32)] }],
    ["a baseline grant reported as ticket-owned", { grantIds: ["b".repeat(32)] }],
    ["two credentials for one ticket", { credentialIds: ["d".repeat(32), "f".repeat(32)] }],
  ])("removes and revokes nothing for %s", async (_name, patch) => {
    const c = controller(patch);
    const result = await transferCleanup({ controller: c.fake, contract: SIMULATED_CONTRACT }).cleanup(randomUUID(), true);
    expect(result).toEqual({ grantsRemoved: false, credentialRevoked: false });
    expect(c.calls.filter(call => call.startsWith("remove") || call.startsWith("revoke"))).toEqual([]);
  });

  it("works from provider state alone after a restart, without qualification", async () => {
    const c = controller({ grantIds: ["c".repeat(32)] });
    // Cleanup must stay available even when a contract is later withdrawn.
    const result = await transferCleanup({ controller: c.fake, contract: UNQUALIFIED_CLEANUP_CONTRACT }).cleanup(randomUUID(), true);
    expect(result).toEqual({ grantsRemoved: true, credentialRevoked: true });
  });
});
