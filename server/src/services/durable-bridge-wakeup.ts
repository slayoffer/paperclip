import type { Db } from "@paperclipai/db";

/** Server-created capability. JSON payloads cannot create this authority. */
export interface DurableBridgeWakeupRequest {
  readonly id: string;
  readonly companyId: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly requestedAt: Date;
  readonly idempotencyKey: string;
  readonly requestedByActorType: "system";
  readonly requestedByActorId: string;
  readonly failedRunRetry?: never;
  readonly authorize: (tx: Db) => Promise<void>;
}

const trusted = new WeakSet<object>();
export function createDurableBridgeWakeupRequest(input: DurableBridgeWakeupRequest): DurableBridgeWakeupRequest {
  const request = Object.freeze({ ...input });
  trusted.add(request);
  return request;
}

export function assertDurableBridgeWakeupRequest(request: DurableBridgeWakeupRequest, scope: {
  companyId: string; issueId: string | null; agentId: string;
  requestedByActorType?: string; requestedByActorId?: string | null;
}) {
  if (!trusted.has(request) || request.companyId !== scope.companyId || request.issueId !== scope.issueId
    || request.agentId !== scope.agentId || scope.requestedByActorType !== "system"
    || request.requestedByActorId !== scope.requestedByActorId) throw new Error("bridge_wakeup_binding_denied");
}

export function assertDurableBridgeWakeupReceipt(request: DurableBridgeWakeupRequest, receipt: {
  id: string; companyId: string; agentId: string; idempotencyKey: string | null;
  requestedByActorType: string | null; requestedByActorId: string | null;
}) {
  if (receipt.id !== request.id || receipt.companyId !== request.companyId || receipt.agentId !== request.agentId
    || receipt.idempotencyKey !== request.idempotencyKey || receipt.requestedByActorType !== "system"
    || receipt.requestedByActorId !== request.requestedByActorId) throw new Error("bridge_wakeup_receipt_conflict");
}
