import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { UploadCorrelationQuery, UploadCorrelationResult } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

export interface UploadReceipt {
  companyId: string;
  issueId: string;
  runId: string | null;
  operationId: string;
  provider: string;
  bindingId: string;
  objectKey: string;
  byteSize: number;
  sha256: string;
  notStarted: boolean;
}

export interface UploadCorrelationRepository {
  runBelongsToIssue(companyId: string, issueId: string, runId: string): Promise<boolean>;
  findReceipt(companyId: string, operationId: string): Promise<UploadReceipt | null>;
  findRegistration(receipt: UploadReceipt): Promise<string | null>;
}

export function emptyUploadCorrelation(operationId: string | null, reason: string): UploadCorrelationResult {
  return {
    outcome: "incomplete_evidence", operationId, objectBinding: null,
    registration: "unresolved", attachmentId: null,
    expectedByteSize: null, expectedSha256: null, actualByteSize: null, actualSha256: null, reason,
  };
}

// This interface cannot upload, delete, list a bucket, or repair a reference.
export async function correlateUpload(input: {
  companyId: string;
  issueId: string;
  authorized: boolean;
  query: UploadCorrelationQuery;
  repository: UploadCorrelationRepository;
  storage: Pick<StorageService, "provider" | "bindingId" | "getObject">;
}): Promise<UploadCorrelationResult> {
  const { query, repository, storage } = input;
  const result = emptyUploadCorrelation(query.operationId ?? null, "Exact historical operation evidence is unavailable");
  const deny = () => ({ ...emptyUploadCorrelation(query.operationId ?? null, "Upload correlation access denied"), outcome: "access_denied" as const });
  if (!input.authorized) return deny();
  if (!await repository.runBelongsToIssue(input.companyId, input.issueId, query.runId)) return deny();
  if (!query.operationId) return result;
  const receipt = await repository.findReceipt(input.companyId, query.operationId);
  if (!receipt) return result;
  if (receipt.companyId !== input.companyId || receipt.issueId !== input.issueId || receipt.runId !== query.runId
    || receipt.operationId !== query.operationId || (query.objectKey && query.objectKey !== receipt.objectKey)
    || !receipt.objectKey.startsWith(`${input.companyId}/issues/${input.issueId}/`) || receipt.objectKey.includes("..")) return deny();

  result.objectBinding = { provider: receipt.provider, bindingId: receipt.bindingId, objectKey: receipt.objectKey };
  result.expectedByteSize = receipt.byteSize;
  result.expectedSha256 = receipt.sha256;
  result.attachmentId = await repository.findRegistration(receipt);
  result.registration = result.attachmentId ? "registered" : "unresolved";
  if (receipt.notStarted && !result.attachmentId) {
    return { ...result, outcome: "operation_absent", registration: "not_started", reason: "The server recorded a stop before provider dispatch" };
  }
  result.reason = "Receipt metadata does not prove downloadable bytes";
  if (query.verifyBytes !== "true") return result;
  if (!query.objectKey) return { ...result, reason: "Byte comparison requires the exact recorded object key" };
  if (!receipt.bindingId || receipt.provider !== storage.provider || receipt.bindingId !== storage.bindingId) {
    return { ...result, reason: "The original storage binding is unavailable" };
  }
  if (!Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1 || receipt.byteSize > MAX_ATTACHMENT_BYTES
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return { ...result, reason: "Receipt byte evidence is invalid or exceeds the comparison bound" };

  const controller = new AbortController();
  let stream: Readable | undefined;
  const timer = setTimeout(() => {
    controller.abort();
    stream?.destroy(new Error("Upload comparison deadline reached"));
  }, 30_000);
  timer.unref();
  try {
    const object = await storage.getObject(input.companyId, receipt.objectKey, { signal: controller.signal });
    stream = object.stream;
    if (controller.signal.aborted) throw new Error("Upload comparison deadline reached");
    let actualByteSize = 0;
    const hash = createHash("sha256");
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualByteSize += bytes.length;
      if (actualByteSize > receipt.byteSize || actualByteSize > MAX_ATTACHMENT_BYTES) {
        return { ...result, reason: "Object exceeds the recorded length" };
      }
      hash.update(bytes);
    }
    result.actualByteSize = actualByteSize;
    result.actualSha256 = hash.digest("hex");
    if (actualByteSize !== receipt.byteSize || result.actualSha256 !== receipt.sha256) {
      return { ...result, reason: "Complete bytes differ from the receipt" };
    }
    return { ...result, outcome: "verified_bytes", reason: "Complete bytes match the exact operation receipt" };
  } catch (error) {
    const status = (error as { status?: number; $metadata?: { httpStatusCode?: number } }).status
      ?? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return { ...result, outcome: status === 403 || status === 401 ? "access_denied" : "incomplete_evidence",
      reason: status === 403 || status === 401 ? "The storage provider denied access" : "Complete object bytes are unavailable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream?.destroy();
  }
}
