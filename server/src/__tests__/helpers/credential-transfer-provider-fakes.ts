import { randomBytes } from "node:crypto";
import type { CleanupContract, CleanupController } from "../../services/credential-transfer-cleanup.js";
import type { R2Admin, R2TokenPolicy, TransferClients, VaultAdmin } from "../../services/credential-transfer-providers.js";

/** Simulated values only. No live provider, credential, or permission is involved. */
export const TOKEN_CANARY = "FAKE-R2-TOKEN-VALUE-CANARY-DO-NOT-LOG";
export const ERROR_CANARY = "FAKE-PROVIDER-ERROR-CANARY-DO-NOT-LOG";
const bound = { evidence: "simulated-qualification-record", maxDelaySeconds: 60 };
/** A simulated qualification. Five 60-second terms give a 300-second budget. It proves no real provider guarantee. */
export const SIMULATED_CONTRACT: Required<CleanupContract> = {
  sourceGrantExpiry: bound, destinationGrantExpiry: bound, completeInventory: bound, issuanceOwnership: bound,
  lateEffectFence: bound, recovery: bound, clockUncertainty: bound, coordination: bound, scopedRemoval: bound,
};
const id32 = () => randomBytes(16).toString("hex");
const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

type Ticket = { deadline: number; baseline: string[]; closed: boolean; issuanceAccepted: boolean };
type Fault = "before" | "lost" | "delayed";

/** Simulated Cloudflare, Infisical, and a provider-enforced cleanup controller sharing one clock. */
export function providerFakes(now: () => number) {
  const r2Baseline = id32(), vaultBaseline = id32();
  const grants = new Map<string, { ticketId: string | null; side: "r2" | "vault" }>([
    [r2Baseline, { ticketId: null, side: "r2" }], [vaultBaseline, { ticketId: null, side: "vault" }]]);
  const tokens = new Map<string, { ticketId: string; value: string; expiresOn: string; policies: R2TokenPolicy[]; revoked: boolean }>();
  const secrets = new Map<string, string>();
  const tickets = new Map<string, Ticket>();
  const faults = new Map<string, Fault>();
  const delayed: (() => void)[] = [];
  const trace: string[] = [];
  const external: unknown[] = [];
  let fenced = 0;
  const r2Inventory = { complete: true, accessDenied: false, principalId: "fake-cloudflare-principal", principalExclusive: true,
    bucket: { name: "test-monitor-bucket", accountId: "a".repeat(32), jurisdiction: "default" } as { name: string; accountId: string; jurisdiction: string } | null,
    permissionGroups: { "6a018a9f2fc74eb6b293b0c548f38b39": "Workers R2 Storage Bucket Item Read" } as Record<string, string> };
  const vaultInventory = { complete: true, accessDenied: false, principalId: "fake-infisical-identity", principalExclusive: true };
  /** Provider-side fence (G5): an effect applies only while its ticket is open and before its deadline. */
  const open = (ticketId: string) => {
    const ticket = tickets.get(ticketId);
    return ticket && !ticket.closed && now() < ticket.deadline ? ticket : null;
  };
  /** Run one provider effect with the configured fault. "lost" applies the effect and loses the reply. */
  function effect<T>(step: string, ticketId: string, apply: () => T): T {
    trace.push(step);
    const fault = faults.get(step);
    if (fault === "before") throw new Error(ERROR_CANARY);
    const guarded = () => {
      if (!open(ticketId)) { fenced++; throw new Error(`fenced ${ERROR_CANARY}`); }
      return apply();
    };
    if (fault === "delayed") {
      delayed.push(() => { try { guarded(); } catch { /* The provider fence dropped the late effect. */ } });
      throw new Error(`timeout ${ERROR_CANARY}`);
    }
    const result = guarded();
    if (fault === "lost") throw new Error(`lost ${ERROR_CANARY} ${TOKEN_CANARY}`);
    return result;
  }
  const owned = (side: "r2" | "vault", ticketId: string) => {
    const id = id32();
    grants.set(id, { ticketId, side });
    return id;
  };
  const r2: R2Admin = {
    async inventory(input) {
      external.push(input);
      return { ...r2Inventory, grantIds: [...grants].filter(([, g]) => g.side === "r2").map(([id]) => id) };
    },
    async activate(input) { external.push(input); effect("r2.activate", input.ticketId, () => owned("r2", input.ticketId)); },
    async createToken(input) {
      external.push(input);
      return effect("createToken", input.ticketId, () => {
        // The provider accepts the request for this ticket before the token applies (G4).
        tickets.get(input.ticketId)!.issuanceAccepted = true;
        const id = id32();
        tokens.set(id, { ticketId: input.ticketId, value: TOKEN_CANARY, expiresOn: input.expiresOn, policies: input.policies, revoked: false });
        return { id, value: TOKEN_CANARY, expiresOn: input.expiresOn, policies: structuredClone(input.policies) };
      });
    },
  };
  const vault: VaultAdmin = {
    async inventory(input) {
      external.push(input);
      return { ...vaultInventory, existingNames: input.names.filter(name => secrets.has(name)),
        grantIds: [...grants].filter(([, g]) => g.side === "vault").map(([id]) => dashed(id)) };
    },
    async activate(input) { external.push(input); effect("vault.activate", input.ticketId, () => owned("vault", input.ticketId)); },
    async createOnly(input) {
      effect(`createOnly:${input.name}`, input.ticketId, () => {
        if (secrets.has(input.name)) throw new Error(`collision ${ERROR_CANARY}`);
        secrets.set(input.name, input.value);
      });
    },
    async readCreated(input) { return effect(`readCreated:${input.name}`, input.ticketId, () => secrets.get(input.name) ?? ""); },
  };
  const cleanup: CleanupController = {
    async register(input) {
      external.push(input);
      trace.push("register");
      if (faults.get("register") === "before") throw new Error(ERROR_CANARY);
      tickets.set(input.ticketId, { deadline: Date.parse(input.deadline), baseline: [...input.baselineGrantIds], closed: false, issuanceAccepted: false });
      if (faults.get("register") === "lost") throw new Error(ERROR_CANARY);
    },
    async close(ticketId) {
      trace.push("close");
      if (faults.get("close") === "before") throw new Error(ERROR_CANARY);
      const ticket = tickets.get(ticketId);
      if (ticket) ticket.closed = true;
    },
    async effects(ticketId) {
      const ticket = tickets.get(ticketId);
      return { settled: true, baselineGrantIds: [...ticket?.baseline ?? []], issuanceAccepted: ticket?.issuanceAccepted ?? false,
        grantIds: [...grants].filter(([, g]) => g.ticketId === ticketId).map(([id]) => id),
        credentialIds: [...tokens].filter(([, t]) => t.ticketId === ticketId && !t.revoked).map(([id]) => id) };
    },
    async removeGrant(ticketId, id) {
      trace.push("removeGrant");
      if (faults.get("removeGrant") === "before") throw new Error(ERROR_CANARY);
      if (grants.get(id)?.ticketId !== ticketId) throw new Error("not ticket-owned");
      grants.delete(id);
    },
    async revokeCredential(ticketId, id) {
      trace.push("revoke");
      const token = tokens.get(id);
      if (token?.ticketId !== ticketId) throw new Error("not ticket-owned");
      token.revoked = true;
    },
  };
  const clients: TransferClients = { r2, vault, cleanup };
  return {
    clients, grants, tokens, secrets, tickets, trace, external, r2Inventory, vaultInventory, baseline: [r2Baseline, vaultBaseline],
    get fenced() { return fenced; },
    fail(step: string, fault: Fault | null) { if (fault) faults.set(step, fault); else faults.delete(step); },
    /** Apply effects that the provider accepted earlier. The provider fence drops effects of closed or expired tickets. */
    applyDelayed() { delayed.splice(0).forEach(run => run()); },
    /** Provider-side expiry without the server process (G1, G2). Grants of expired tickets disappear. */
    providerExpiry() {
      for (const [ticketId, ticket] of tickets) {
        if (now() < ticket.deadline) continue;
        ticket.closed = true;
        for (const [id, grant] of grants) if (grant.ticketId === ticketId) grants.delete(id);
      }
    },
    temporaryGrants: () => [...grants].filter(([, g]) => g.ticketId !== null).map(([id]) => id),
    activeTokens: () => [...tokens.values()].filter(t => !t.revoked),
  };
}
