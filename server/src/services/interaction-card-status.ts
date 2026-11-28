import { issueThreadInteractions, type Db } from "@paperclipai/db";
import type { IssueThreadInteractionStatus } from "@paperclipai/shared";
import { and, eq, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { HttpError } from "../errors.js";
import { captureInteractionWipAdmission, type InteractionWipActor } from "./interaction-wip-admission.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type InteractionCardStatusTransaction = Pick<DbTransaction, "select" | "execute" | "update" | "rollback">;
type CardStatusScope = {
  issue: { id: string; companyId: string };
  actor: InteractionWipActor;
};
type CardStatusChange = {
  where: SQL | undefined;
  values: Omit<PgUpdateSetSource<typeof issueThreadInteractions>, "id" | "companyId" | "issueId" | "status">
    & { status: IssueThreadInteractionStatus; id?: never; companyId?: never; issueId?: never };
};
export type InteractionCardStatusWriter = (change: CardStatusChange) => Promise<Array<typeof issueThreadInteractions.$inferSelect>>;

/** Use the caller's transaction for all card writes and the final admission check. */
export async function withInteractionCardStatusWriter<T>(
  tx: InteractionCardStatusTransaction,
  { issue, actor }: CardStatusScope,
  mutate: (write: InteractionCardStatusWriter) => Promise<T>,
): Promise<T> {
  const assertWip = await captureInteractionWipAdmission(tx, issue, actor);
  let changed = false;
  const result = await mutate(async ({ where, values }) => {
    const rows = await tx.update(issueThreadInteractions).set(values).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      where,
    )).returning();
    changed ||= rows.length > 0;
    return rows;
  });
  if (changed) await assertWip?.();
  return result;
}

export function writeInteractionCardStatus(
  tx: InteractionCardStatusTransaction,
  { issue, actor, ...change }: CardStatusScope & CardStatusChange,
) {
  return withInteractionCardStatusWriter(tx, { issue, actor }, (write) => write(change));
}

export function isInteractionCardWipRefusal(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409
    && typeof error.details === "object" && error.details !== null
    && "code" in error.details && error.details.code === "agent_wip_limit";
}
