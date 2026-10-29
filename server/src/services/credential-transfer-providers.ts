import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import type { CreateCredentialTransfer, CredentialTransferOperation } from "@paperclipai/shared";
import { resolveConnectionGrantSecret } from "./connection-credentials.js";
import { credentialTransferAuthority, type TransferToolMap } from "./credential-transfer-authority.js";
import { credentialTransferJournal } from "./credential-transfer-journal.js";
import {
  credentialTransferService, CredentialTransferError, type TransferActor, type TransferProviders,
} from "./credential-transfer.js";
import {
  qualifyCleanupContract, transferCleanup, UNQUALIFIED_CLEANUP_CONTRACT, type CleanupContract, type CleanupController,
} from "./credential-transfer-cleanup.js";
import type { ToolGatewayService } from "./tool-gateway.js";

/** Cloudflare permission group "Workers R2 Storage Bucket Item Read". Inspection must confirm it. */
export const R2_OBJECT_READ_PERMISSION_GROUP_ID = "6a018a9f2fc74eb6b293b0c548f38b39";
const ID32 = /^[a-f0-9]{32}$/;

export function r2BucketResource(operation: Pick<CredentialTransferOperation, "accountId" | "jurisdiction" | "bucket">) {
  return `com.cloudflare.edge.r2.bucket.${operation.accountId}_${operation.jurisdiction}_${operation.bucket}`;
}

/** Metadata only. `complete` is false when any page or effective grant is missing. */
export type R2Inventory = {
  complete: boolean;
  accessDenied: boolean;
  principalId: string;
  principalExclusive: boolean;
  bucket: { name: string; accountId: string; jurisdiction: string } | null;
  /** Every effective grant of the bound principal before activation. */
  grantIds: string[];
  /** Permission group identifier to name, as the provider reports them. */
  permissionGroups: Record<string, string>;
};
export type R2TokenPolicy = { effect: "allow"; resources: Record<string, "*">; permissionGroups: { id: string }[] };
/** In-process Cloudflare client built from the bound source connection credential. */
export interface R2Admin {
  inventory(input: { accountId: string; bucket: string; jurisdiction: string }): Promise<R2Inventory>;
  /** Add only the accepted temporary administration grants to the bound principal. The ticket owns them. */
  activate(input: { ticketId: string; accountId: string; deadline: string }): Promise<void>;
  /** One request. The provider binds the new token to `ticketId` before the token can apply. */
  createToken(input: { ticketId: string; accountId: string; name: string; policies: R2TokenPolicy[]; expiresOn: string }):
    Promise<{ id: string; value: string; expiresOn: string; policies: R2TokenPolicy[] }>;
}
export type VaultTarget = { project: string; environment: string; path: string };
export type VaultInventory = {
  complete: boolean;
  accessDenied: boolean;
  principalId: string;
  principalExclusive: boolean;
  /** Names from the requested set that exist at the target. Values are never read. */
  existingNames: string[];
  grantIds: string[];
};
/** In-process Infisical client built from the bound destination connection credential. */
export interface VaultAdmin {
  inventory(input: VaultTarget & { names: readonly string[] }): Promise<VaultInventory>;
  /** Add only the accepted conditional rule (describe, create, read value) for the two names. The ticket owns it. */
  activate(input: VaultTarget & { ticketId: string; names: readonly string[]; deadline: string }): Promise<void>;
  /** Create only. A collision fails. No update, delete, or retry. */
  createOnly(input: VaultTarget & { ticketId: string; name: string; value: string }): Promise<void>;
  readCreated(input: VaultTarget & { ticketId: string; name: string }): Promise<string>;
}
export type TransferClients = { r2: R2Admin; vault: VaultAdmin; cleanup: CleanupController };

/** Provider identifiers are 32 hex characters. Infisical UUIDs lose their dashes. Anything else is invalid. */
function grantId(value: string) {
  const id = value.toLowerCase().replaceAll("-", "");
  return ID32.test(id) ? id : "invalid";
}
/** The journal and receipt keep a one-way reference. The token identifier is also the S3 access key ID. */
export function credentialFingerprint(tokenId: string) {
  return createHash("sha256").update(`r2-token:${tokenId}`).digest("hex").slice(0, 32);
}
function sameInstant(left: string, right: string) {
  const a = Date.parse(left);
  return Number.isFinite(a) && a === Date.parse(right);
}

/** Implements `TransferProviders`. Issuance, derivation, storage, and comparison stay in this server process. */
export function credentialTransferProviders(deps: {
  clients: () => Promise<TransferClients>;
  contract: CleanupContract;
  now?: () => number;
}): TransferProviders {
  let loaded: Promise<TransferClients> | null = null;
  const clients = () => (loaded ??= deps.clients());
  let cleanup: ReturnType<typeof transferCleanup> | null = null;
  const cleaner = async () => (cleanup ??= transferCleanup({ controller: (await clients()).cleanup,
    contract: deps.contract, now: deps.now }));
  const armed = new Map<string, CredentialTransferOperation>();
  async function admitted(ticketId: string) {
    const operation = armed.get(ticketId);
    if (!operation) throw new CredentialTransferError(409, "ticket_unknown");
    (await cleaner()).admit(operation);
    return operation;
  }
  const target = (operation: CredentialTransferOperation): VaultTarget =>
    ({ project: operation.project, environment: operation.environment, path: operation.path });
  return {
    async inspect(operation) {
      // Refuse before any provider call or credential read when a guarantee is unsupported.
      if (!qualifyCleanupContract(deps.contract).qualified) throw new CredentialTransferError(422, "provider_guarantees_unqualified");
      const { r2, vault } = await clients();
      const source = await r2.inventory({ accountId: operation.accountId, bucket: operation.bucket, jurisdiction: operation.jurisdiction });
      const destination = await vault.inventory({ ...target(operation), names: operation.names });
      const bucket = source.bucket;
      const readGroup = source.permissionGroups[R2_OBJECT_READ_PERMISSION_GROUP_ID] === "Workers R2 Storage Bucket Item Read";
      return {
        complete: source.complete && destination.complete && !source.accessDenied && !destination.accessDenied,
        accountId: bucket?.accountId ?? "",
        bucket: bucket?.name ?? "",
        jurisdiction: bucket?.jurisdiction ?? "",
        bucketOwned: bucket?.accountId === operation.accountId,
        identityExclusive: source.principalExclusive && destination.principalExclusive
          && source.principalId.length > 0 && destination.principalId.length > 0,
        effectivePermission: readGroup ? "Object Read" : "denied",
        baselineGrantIds: [...source.grantIds, ...destination.grantIds].map(grantId),
        destinationCount: new Set(destination.existingNames).size,
        safeAutomaticRemoval: (await cleaner()).qualified(),
      };
    },
    async arm(input) {
      await (await cleaner()).arm(input);
      armed.set(input.ticketId, input.operation);
    },
    async activate(ticketId) {
      const operation = await admitted(ticketId);
      const { r2, vault } = await clients();
      await r2.activate({ ticketId, accountId: operation.accountId, deadline: operation.grantDeadline });
      await admitted(ticketId);
      await vault.activate({ ...target(operation), ticketId, names: operation.names, deadline: operation.grantDeadline });
    },
    async issue(ticketId) {
      const operation = await admitted(ticketId);
      const { r2, cleanup: controller } = await clients();
      // Provider evidence, not process memory, decides. An accepted earlier request forbids another issuance.
      const prior = await controller.effects(ticketId);
      if (prior.issuanceAccepted || prior.credentialIds.length) throw new CredentialTransferError(409, "issuance_already_accepted");
      await admitted(ticketId);
      const resource = r2BucketResource(operation);
      const token = await r2.createToken({ ticketId, accountId: operation.accountId, name: operation.credentialName,
        policies: [{ effect: "allow", resources: { [resource]: "*" }, permissionGroups: [{ id: R2_OBJECT_READ_PERMISSION_GROUP_ID }] }],
        expiresOn: operation.credentialExpiresAt });
      const policy = token.policies.length === 1 ? token.policies[0] : undefined;
      const scoped = policy?.effect === "allow" && Object.keys(policy.resources).length === 1 && policy.resources[resource] === "*"
        && policy.permissionGroups.length === 1 && policy.permissionGroups[0]?.id === R2_OBJECT_READ_PERMISSION_GROUP_ID;
      return {
        credentialId: ID32.test(token.id) ? credentialFingerprint(token.id) : "invalid",
        // Cloudflare R2: access key ID = token ID, secret access key = SHA-256 of the token value.
        accessKeyId: token.id,
        secretAccessKey: createHash("sha256").update(token.value).digest("hex"),
        bucket: scoped ? operation.bucket : "",
        accountId: scoped ? operation.accountId : "",
        jurisdiction: scoped ? operation.jurisdiction : "",
        permission: scoped ? "Object Read" : "denied",
        expiresAt: sameInstant(token.expiresOn, operation.credentialExpiresAt) ? operation.credentialExpiresAt : "invalid",
      };
    },
    async createOnly(ticketId, name, value) {
      const operation = await admitted(ticketId);
      if (!operation.names.includes(name)) throw new CredentialTransferError(422, "destination_invalid");
      await (await clients()).vault.createOnly({ ...target(operation), ticketId, name, value });
    },
    async readCreated(ticketId, name) {
      const operation = await admitted(ticketId);
      if (!operation.names.includes(name)) throw new CredentialTransferError(422, "destination_invalid");
      return (await clients()).vault.readCreated({ ...target(operation), ticketId, name });
    },
    // Cleanup needs no process memory. A fresh adapter after restart reads the provider ticket.
    cleanup: async (ticketId, revokeCredential) => (await cleaner()).cleanup(ticketId, revokeCredential),
  };
}

export type TransferCredentials = Record<"source" | "destination", Record<string, string>>;

/** Read the bound personal credentials in process. The bound secret version is pinned. No other principal is used. */
export async function resolveTransferCredentials(db: Db, actor: TransferActor, request: CreateCredentialTransfer) {
  const credentials: TransferCredentials = { source: {}, destination: {} };
  for (const side of ["source", "destination"] as const) {
    const binding = request[side];
    const [connection] = await db.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, actor.companyId), eq(toolConnections.id, binding.connectionId)));
    const [grant] = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, actor.companyId), eq(connectionGrants.id, binding.grantId)));
    if (!connection || !grant || grant.connectionId !== connection.id || grant.kind !== "user"
      || grant.subjectUserId !== actor.userId || !grant.credentialSecretRefs.length) {
      throw new CredentialTransferError(403, "transfer_authority_invalid");
    }
    for (const ref of grant.credentialSecretRefs) {
      const version = binding.credentialVersions[ref.secretId];
      if (!version) throw new CredentialTransferError(403, "transfer_authority_invalid");
      const resolved = await resolveConnectionGrantSecret(db, connection, grant, { ...ref, versionSelector: version }, {
        consumerType: "tool_connection", consumerId: connection.id, actorType: "agent", actorId: actor.agentId,
        responsibleUserId: actor.userId, issueId: actor.issueId,
      });
      credentials[side][ref.configPath] = resolved.value;
    }
  }
  return credentials;
}

/**
 * A qualified registry names reviewed in-process clients, their server-owned gateway tools, and the provider
 * guarantee evidence. The application ships without one, so the route refuses every transfer.
 */
export type TransferProviderRegistry = {
  contract: CleanupContract;
  tools: { source: readonly string[]; destination: readonly string[]; operations: TransferToolMap } | null;
  clients: ((credentials: TransferCredentials) => TransferClients) | null;
};
export const UNQUALIFIED_PROVIDER_REGISTRY: Readonly<TransferProviderRegistry> = Object.freeze({
  contract: UNQUALIFIED_CLEANUP_CONTRACT, tools: null, clients: null,
});

export function credentialTransferServiceFactory(db: Db, gateway: Pick<ToolGatewayService, "authorizeCredentialTransfer">,
  registry: TransferProviderRegistry = UNQUALIFIED_PROVIDER_REGISTRY, now?: () => number) {
  return (sessionToken: string) => {
    const { clients, tools, contract } = registry;
    if (!clients || !tools || !qualifyCleanupContract(contract).qualified) {
      // 422 keeps the fixed code visible. Secret-sensitive 5xx responses hide it.
      throw new CredentialTransferError(422, "provider_guarantees_unqualified");
    }
    return {
      execute(actor: TransferActor, request: CreateCredentialTransfer) {
        const providers = credentialTransferProviders({ contract, now,
          clients: async () => clients(await resolveTransferCredentials(db, actor, request)) });
        return credentialTransferService({ authority: credentialTransferAuthority(db, gateway, sessionToken, tools),
          journal: credentialTransferJournal(db), providers, now }).execute(actor, request);
      },
    };
  };
}
