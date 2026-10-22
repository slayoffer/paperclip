import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { CreateCredentialTransfer, CredentialTransferOperation } from "@paperclipai/shared";

/** Internal recovery journal. Never store provider payloads, credentials, or error messages. */
export const credentialTransfers = pgTable("credential_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  userId: text("user_id").notNull(),
  permissionApprovalId: uuid("permission_approval_id").notNull(),
  issuanceApprovalId: uuid("issuance_approval_id").notNull(),
  bindings: jsonb("bindings").$type<CreateCredentialTransfer>().notNull(),
  operation: jsonb("operation").$type<CredentialTransferOperation>().notNull(),
  state: text("state").$type<"prepared" | "armed" | "issuing" | "storing" | "complete" | "revoked" | "cleanup_required">().notNull(),
  baselineGrantIds: jsonb("baseline_grant_ids").$type<string[]>().notNull().default([]),
  cleanupTicketId: uuid("cleanup_ticket_id"),
  credentialId: text("credential_id"),
  storedNames: jsonb("stored_names").$type<string[]>().notNull().default([]),
  grantDeadline: timestamp("grant_deadline", { withTimezone: true }).notNull(),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // One issuance per accepted revision, including after failure or process loss.
  uniqueIndex("credential_transfers_issuance_uq").on(table.companyId, table.issuanceApprovalId),
  uniqueIndex("credential_transfers_permission_uq").on(table.companyId, table.permissionApprovalId),
  index("credential_transfers_cleanup_idx").on(table.state, table.grantDeadline),
]);
