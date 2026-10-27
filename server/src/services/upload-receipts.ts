import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, assets, heartbeatRuns, issueAttachments, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import type { PutFileResult, StorageService } from "../storage/types.js";
import type { UploadReceipt, UploadCorrelationRepository } from "./upload-correlation.js";
import { conflict, forbidden } from "../errors.js";

const ENTITY = "attachment_upload";
const PREPARED = "attachment.upload_prepared";
const NOT_STARTED = "attachment.upload_not_started";

function runIssueScope(companyId: string, issueId: string, runId: string) {
  return and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId', ${heartbeatRuns.contextSnapshot}->'paperclipIssue'->>'id') = ${issueId}`,
  );
}

export function uploadReceiptService(db: Db): UploadCorrelationRepository & {
  beforePut(input: {
    companyId: string; issueId: string; operationId: string;
    actorType: "agent" | "user"; actorId: string; agentId: string | null; runId: string | null;
    storage: StorageService;
  }): (planned: PutFileResult) => Promise<void>;
} {
  return {
    beforePut(input) {
      return async (planned) => {
        if (input.actorType === "agent") {
          if (!input.agentId || !input.runId || !isUuidLike(input.runId)) throw forbidden("Agent uploads require their active issue run");
          const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            runIssueScope(input.companyId, input.issueId, input.runId),
            eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
          )).limit(1);
          if (!run) throw forbidden("Upload run must belong to the agent and exact issue");
        } else if (input.runId) {
          throw forbidden("Board uploads cannot attribute an agent run");
        }
        // The primary key reserves the identity. A duplicate never sends more bytes.
        const rows = await db.insert(activityLog).values({
          id: input.operationId, companyId: input.companyId,
          actorType: input.actorType, actorId: input.actorId, agentId: input.agentId,
          runId: input.runId, entityType: ENTITY, entityId: input.operationId, action: PREPARED,
          details: { version: 1, issueId: input.issueId, ...planned, bindingId: input.storage.bindingId ?? "" },
        }).onConflictDoNothing().returning({ id: activityLog.id });
        if (rows.length !== 1) throw conflict("Upload operation already exists. Correlate it before another upload.");
        const event = {
          companyId: input.companyId, actorType: input.actorType, actorId: input.actorId,
          agentId: input.agentId, runId: input.runId, entityType: ENTITY, entityId: input.operationId,
        };
        try {
          await db.insert(activityLog).values({ ...event, id: randomUUID(), action: "attachment.upload_started" });
        } catch (error) {
          // The provider was never called, even when this audit write had an ambiguous commit.
          await db.insert(activityLog).values({ ...event, id: randomUUID(), action: NOT_STARTED }).catch(() => {});
          throw error;
        }
      };
    },
    async runBelongsToIssue(companyId, issueId, runId) {
      const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(runIssueScope(companyId, issueId, runId)).limit(1);
      return Boolean(run);
    },
    async findReceipt(companyId, operationId) {
      const [row] = await db.select().from(activityLog).where(and(
        eq(activityLog.id, operationId), eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, ENTITY), eq(activityLog.entityId, operationId), eq(activityLog.action, PREPARED),
      )).limit(1);
      if (!row) return null;
      const details = row.details;
      if (!details || details.version !== 1 || typeof details.issueId !== "string" || typeof details.objectKey !== "string"
        || typeof details.provider !== "string" || typeof details.bindingId !== "string" || typeof details.byteSize !== "number"
        || typeof details.sha256 !== "string") return null;
      const [notStarted] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.entityType, ENTITY),
        eq(activityLog.entityId, operationId), eq(activityLog.action, NOT_STARTED),
      )).limit(1);
      return { companyId, operationId, issueId: details.issueId, runId: row.runId, provider: details.provider,
        bindingId: details.bindingId, objectKey: details.objectKey, byteSize: details.byteSize,
        sha256: details.sha256, notStarted: Boolean(notStarted) };
    },
    async findRegistration(receipt: UploadReceipt) {
      if (!receipt.runId) return null;
      const [row] = await db.select({ id: issueAttachments.id }).from(issueAttachments)
        .innerJoin(assets, eq(assets.id, issueAttachments.assetId)).where(and(
          eq(issueAttachments.companyId, receipt.companyId), eq(issueAttachments.issueId, receipt.issueId),
          eq(issueAttachments.originatingRunId, receipt.runId), eq(assets.companyId, receipt.companyId),
          eq(assets.provider, receipt.provider), eq(assets.objectKey, receipt.objectKey),
          eq(assets.sha256, receipt.sha256), eq(assets.byteSize, receipt.byteSize),
        )).limit(1);
      return row?.id ?? null;
    },
  };
}
