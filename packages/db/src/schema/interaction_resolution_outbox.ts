import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

export const interactionResolutionOutbox = pgTable("interaction_resolution_outbox", {
  interactionId: uuid("interaction_id").primaryKey().references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  wakes: jsonb("wakes").$type<Array<{ agentId: string; options: Record<string, unknown> }>>().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({ pendingIdx: index("interaction_resolution_outbox_pending_idx").on(table.deliveredAt, table.createdAt) }));
