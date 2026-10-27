import { z } from "zod";

export const uploadCorrelationQuerySchema = z.object({
  runId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
  objectKey: z.string().min(1).max(2048).optional(),
  verifyBytes: z.enum(["true", "false"]).default("false"),
}).strict();

export type UploadCorrelationQuery = z.infer<typeof uploadCorrelationQuerySchema>;

export interface UploadCorrelationResult {
  outcome: "verified_bytes" | "incomplete_evidence" | "access_denied" | "operation_absent";
  operationId: string | null;
  objectBinding: { provider: string; bindingId: string; objectKey: string } | null;
  registration: "registered" | "unresolved" | "not_started";
  attachmentId: string | null;
  expectedByteSize: number | null;
  expectedSha256: string | null;
  actualByteSize: number | null;
  actualSha256: string | null;
  reason: string;
}
