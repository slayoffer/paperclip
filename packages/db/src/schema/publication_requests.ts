import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PublicationBindings, PublicationRequestState } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Protected records. This source slice exposes no registration or publication route.
export const publicationAuthorityClocks = pgTable("publication_authority_clocks", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  lastTimeMs: bigint("last_time_ms", { mode: "number" }).notNull(),
  lastMonotonicMs: bigint("last_monotonic_ms", { mode: "number" }).notNull(),
  clockEpoch: text("clock_epoch").notNull(),
  uncertain: boolean("uncertain").notNull().default(false),
});

export const publicationBrokers = pgTable("publication_brokers", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  certificateId: text("certificate_id").notNull(),
  issuerId: text("issuer_id").notNull(),
  validFromMs: bigint("valid_from_ms", { mode: "number" }).notNull(),
  validUntilMs: bigint("valid_until_ms", { mode: "number" }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  issuerRevoked: boolean("issuer_revoked").notNull().default(false),
}, (t) => ({
  companyIdUq: unique("publication_brokers_company_id_uq").on(t.companyId, t.id),
  certificateUq: unique("publication_brokers_certificate_uq").on(t.issuerId, t.certificateId),
  validity: check("publication_brokers_validity", sql`${t.validUntilMs} > ${t.validFromMs}`),
}));

export const publicationRequests = pgTable("publication_requests", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  brokerId: uuid("broker_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
  repository: text("repository").notNull(),
  branch: text("branch").notNull(),
  bindings: jsonb("bindings").$type<PublicationBindings>().notNull(),
  issuedAtMs: bigint("issued_at_ms", { mode: "number" }).notNull(),
  issuedMonotonicMs: bigint("issued_monotonic_ms", { mode: "number" }).notNull(),
  expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
  state: text("state").$type<PublicationRequestState>().notNull().default("pending"),
  dispatchedAtMs: bigint("dispatched_at_ms", { mode: "number" }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  reconciliationId: uuid("reconciliation_id"),
}, (t) => ({
  brokerFk: foreignKey({ columns: [t.companyId, t.brokerId], foreignColumns: [publicationBrokers.companyId, publicationBrokers.id] }),
  issueFk: foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id] }),
  repositoryCanonical: check("publication_requests_repository_canonical", sql`${t.repository} ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' and ${t.repository} !~ '[.]git$'`),
  repositoryBindings: check("publication_requests_repository_bindings", sql`(${t.bindings}->>'repository') is not distinct from ${t.repository} and (${t.bindings}->>'operation' = 'push' or (${t.bindings}->>'sourceRepository') is not distinct from ${t.repository})`),
  lifetime: check("publication_requests_lifetime", sql`${t.expiresAtMs} > ${t.issuedAtMs} and ${t.expiresAtMs} <= ${t.issuedAtMs} + 30000`),
  stateCheck: check("publication_requests_state", sql`${t.state} in ('pending', 'dispatched', 'unknown', 'succeeded', 'refused', 'revoked')`),
  dispatchCheck: check("publication_requests_dispatch", sql`(${t.state} in ('pending', 'revoked') and ${t.dispatchedAtMs} is null) or (${t.state} in ('dispatched', 'unknown', 'succeeded', 'refused') and ${t.dispatchedAtMs} is not null)`),
  issueIdx: index("publication_requests_company_issue_idx").on(t.companyId, t.issueId),
  outstandingUq: uniqueIndex("publication_requests_outstanding_uq").on(t.companyId, t.repository, t.branch)
    .where(sql`${t.state} in ('dispatched', 'unknown')`),
}));
