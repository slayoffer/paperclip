import type { CredentialTransferOperation } from "@paperclipai/shared";
import { CredentialTransferError } from "./credential-transfer.js";

/** The approved temporary grant window. A delayed activation never extends it. */
export const GRANT_WINDOW_MS = 60 * 60 * 1000;

/** One supported provider guarantee. `evidence` names the qualification record. It never holds a secret. */
export type GuaranteeBound = { evidence: string; maxDelaySeconds: number };

/**
 * Provider guarantees that the approved contract requires. The keys map to gaps G1-G7 of the
 * SYNA-3090 qualification record. A missing key means "unsupported". Unsupported guarantees prevent activation.
 */
export type CleanupContract = {
  /** G1: provider expiry, or bounded independent removal, of the temporary Cloudflare grants. Part of M. */
  sourceGrantExpiry?: GuaranteeBound;
  /** G2: provider expiry of the temporary Infisical privilege for the existing identity. Part of M. */
  destinationGrantExpiry?: GuaranteeBound;
  /** G3: complete paginated inventory and effective grants for both bound identities. */
  completeInventory?: GuaranteeBound;
  /** G4: ticket-unique issuance ownership. Resolves a lost response to zero or one credential. Part of M. */
  issuanceOwnership?: GuaranteeBound;
  /** G5: a provider fence, or a settlement bound, for every accepted activation, issuance, and storage request (S). */
  lateEffectFence?: GuaranteeBound;
  /** G6 term R: interruption and recovery delay, including server restart and journal availability. */
  recovery?: GuaranteeBound;
  /** G6 term C: total clock uncertainty across the server and both providers. */
  clockUncertainty?: GuaranteeBound;
  /** G6 term Q: other coordination delay. */
  coordination?: GuaranteeBound;
  /** G7: removal of only ticket-owned grants. Concurrent unrelated grants survive. */
  scopedRemoval?: GuaranteeBound;
};

/** The production default. No provider guarantee is qualified, so every activation is refused. */
export const UNQUALIFIED_CLEANUP_CONTRACT: Readonly<CleanupContract> = Object.freeze({});

const TERMS = [
  ["sourceGrantExpiry", "G1"], ["destinationGrantExpiry", "G2"], ["completeInventory", "G3"],
  ["issuanceOwnership", "G4"], ["lateEffectFence", "G5"], ["recovery", "G6"], ["clockUncertainty", "G6"],
  ["coordination", "G6"], ["scopedRemoval", "G7"],
] as const satisfies readonly (readonly [keyof CleanupContract, string])[];

export type CleanupQualification =
  | { qualified: true; budgetMs: number; missing: [] }
  | { qualified: false; missing: string[] };

/** Every term needs evidence and a finite bound. The sum S + R + M + C + Q must fit inside the grant window. */
export function qualifyCleanupContract(contract: CleanupContract): CleanupQualification {
  const missing = new Set<string>();
  for (const [key, gap] of TERMS) {
    const bound = contract[key];
    if (!bound || typeof bound.evidence !== "string" || !bound.evidence.trim()
      || !Number.isSafeInteger(bound.maxDelaySeconds) || bound.maxDelaySeconds < 0) missing.add(gap);
  }
  if (missing.size) return { qualified: false, missing: [...missing].sort() };
  const c = contract as Required<CleanupContract>;
  const removal = Math.max(c.sourceGrantExpiry.maxDelaySeconds, c.destinationGrantExpiry.maxDelaySeconds,
    c.issuanceOwnership.maxDelaySeconds);
  const budgetMs = 1000 * (c.lateEffectFence.maxDelaySeconds + c.recovery.maxDelaySeconds + removal
    + c.clockUncertainty.maxDelaySeconds + c.coordination.maxDelaySeconds);
  if (budgetMs >= GRANT_WINDOW_MS) return { qualified: false, missing: ["G6"] };
  return { qualified: true, budgetMs, missing: [] };
}

/** Provider evidence for one ticket. It never contains a secret value. */
export type TicketEffects = {
  /** False while an accepted activation, issuance, or storage request can still apply. */
  settled: boolean;
  /** Baseline grant identifiers that the provider recorded at registration. */
  baselineGrantIds: string[];
  /** Ticket-owned temporary grants that are still effective. */
  grantIds: string[];
  /** Ticket-owned issued credentials that are still effective. More than one means broken ownership. */
  credentialIds: string[];
  /** True when the provider accepted an issuance request for this ticket, even if its response was lost. */
  issuanceAccepted: boolean;
};

/**
 * The provider-enforced cleanup controller. The application consumes it. It cannot create it.
 * A qualified implementation enforces expiry at `deadline` without this server process,
 * refuses ticket effects after `close`, and attributes effects to tickets without name matching.
 * `close` and `effects` accept an unknown ticket (a lost `register` request) and report no effects.
 */
export interface CleanupController {
  register(ticket: { ticketId: string; transferId: string; deadline: string; baselineGrantIds: string[] }): Promise<void>;
  close(ticketId: string): Promise<void>;
  effects(ticketId: string): Promise<TicketEffects>;
  removeGrant(ticketId: string, grantId: string): Promise<void>;
  revokeCredential(ticketId: string, credentialId: string): Promise<void>;
}

function refuse(status: number, code: string): never {
  throw new CredentialTransferError(status, code);
}

export function transferCleanup(deps: { controller: CleanupController; contract: CleanupContract; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const budget = () => {
    const result = qualifyCleanupContract(deps.contract);
    if (!result.qualified) refuse(422, "provider_guarantees_unqualified");
    return result.budgetMs;
  };
  return {
    qualified: () => qualifyCleanupContract(deps.contract).qualified,
    /** Register the provider ticket before any temporary grant can apply. */
    async arm(input: { ticketId: string; transferId: string; operation: CredentialTransferOperation; baselineGrantIds: string[] }) {
      const budgetMs = budget();
      const deadline = Date.parse(input.operation.grantDeadline);
      const earliestActivation = now();
      // D <= A + 60 minutes, and the complete worst-case bound must fit before D.
      if (!(deadline - earliestActivation <= GRANT_WINDOW_MS && earliestActivation + budgetMs <= deadline)) {
        refuse(422, "cleanup_window_insufficient");
      }
      await deps.controller.register({ ticketId: input.ticketId, transferId: input.transferId,
        deadline: input.operation.grantDeadline, baselineGrantIds: [...input.baselineGrantIds] });
    },
    /** Dispatch guard: last_dispatch + S + R + M + C + Q <= D. */
    admit(operation: CredentialTransferOperation) {
      if (now() + budget() > Date.parse(operation.grantDeadline)) refuse(409, "dispatch_window_closed");
    },
    /** Idempotent. Close, settle, remove only ticket-owned grants, and revoke only the ticket-owned credential. */
    async cleanup(ticketId: string, revokeCredential: boolean) {
      await deps.controller.close(ticketId);
      const before = await deps.controller.effects(ticketId);
      const baseline = new Set(before.baselineGrantIds);
      // Unsettled requests can still apply. Broken ownership never permits a guess.
      if (!before.settled || before.grantIds.some(id => baseline.has(id)) || before.credentialIds.length > 1) {
        return { grantsRemoved: false, credentialRevoked: false };
      }
      for (const id of before.grantIds) await deps.controller.removeGrant(ticketId, id);
      if (revokeCredential) {
        for (const id of before.credentialIds) await deps.controller.revokeCredential(ticketId, id);
      }
      const after = await deps.controller.effects(ticketId);
      return { grantsRemoved: after.settled && after.grantIds.length === 0,
        credentialRevoked: after.credentialIds.length === 0 };
    },
  };
}
