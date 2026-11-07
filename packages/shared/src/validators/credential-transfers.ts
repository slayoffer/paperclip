import { z } from "zod";

const binding = z.object({
  connectionId: z.string().uuid(),
  connectionVersion: z.string().datetime(),
  grantId: z.string().uuid(),
  grantVersion: z.string().datetime(),
  credentialVersions: z.record(z.string().uuid(), z.number().int().positive()),
}).strict();
const approval = z.object({
  interactionId: z.string().uuid(),
  documentId: z.string().uuid(),
  revisionId: z.string().uuid(),
}).strict();

/** This request contains references only. The operation document fixes every target. */
export const createCredentialTransferSchema = z.object({
  issueId: z.string().uuid(),
  source: binding,
  destination: binding,
  permissionApproval: approval,
  issuanceApproval: approval,
}).strict();
export type CreateCredentialTransfer = z.infer<typeof createCredentialTransferSchema>;

export const credentialTransferOperationSchema = z.object({
  version: z.literal(1),
  operation: z.enum(["r2_permission_window", "r2_credential_transfer"]),
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  agentId: z.string().uuid(),
  userId: z.string().min(1).max(256),
  source: binding,
  destination: binding,
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  jurisdiction: z.enum(["default", "eu", "fedramp"]),
  permission: z.literal("Object Read"),
  credentialName: z.literal("synthiq-clpn-r2-monitor"),
  credentialExpiresAt: z.string().datetime(),
  grantDeadline: z.string().datetime(),
  executionDeadline: z.string().datetime(),
  project: z.literal("synthiq-infra"),
  environment: z.literal("prod"),
  path: z.literal("/clpn-ha"),
  names: z.tuple([z.literal("CLPN_R2_MONITOR_ACCESS_KEY_ID"), z.literal("CLPN_R2_MONITOR_SECRET_ACCESS_KEY")]),
}).strict();
export type CredentialTransferOperation = z.infer<typeof credentialTransferOperationSchema>;
