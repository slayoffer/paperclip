import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { RuntimeStatusUpdate } from "@paperclipai/adapter-utils";
import type { HeartbeatRunStatusPhase } from "@paperclipai/shared";
import { publishLiveEvent } from "./live-events.js";
import { clearHeartbeatRunRuntimeStatus, setHeartbeatRunRuntimeStatus } from "./heartbeat-run-runtime-status.js";

const isHeartbeatRunRuntimeStatusActive = (status: string) => status === "queued" || status === "running";
const readNonEmptyString = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value : null;

export function publishHeartbeatRunRuntimeProgress(status: {
  companyId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  phase: HeartbeatRunStatusPhase;
  message: string;
  updatedAt: Date;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | null;
}) {
  publishLiveEvent({
    companyId: status.companyId,
    type: "heartbeat.run.progress",
    payload: {
      runId: status.runId,
      agentId: status.agentId,
      issueId: status.issueId,
      phase: status.phase,
      message: status.message,
      currentToolName: status.currentToolName ?? null,
      lastAssistantSnippet: status.lastAssistantSnippet ?? null,
      lastEventAt: (status.lastEventAt ?? status.updatedAt).toISOString(),
      updatedAt: status.updatedAt.toISOString(),
    },
  });
}

function recordHeartbeatRunRuntimeProgress(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "id" | "companyId" | "agentId" | "status"
  >,
  update: RuntimeStatusUpdate,
  issueId: string | null,
) {
  if (!isHeartbeatRunRuntimeStatusActive(run.status)) return null;
  const status = setHeartbeatRunRuntimeStatus({
    companyId: run.companyId,
    issueId,
    agentId: run.agentId,
    runId: run.id,
    phase: update.phase as HeartbeatRunStatusPhase,
    message: update.message,
    currentToolName: readNonEmptyString(update.currentToolName) ?? null,
    lastAssistantSnippet:
      readNonEmptyString(update.lastAssistantSnippet) ?? null,
    lastEventAt: update.lastEventAt ? new Date(update.lastEventAt) : new Date(),
  });
  if (!status) return null;

  publishHeartbeatRunRuntimeProgress(status);
  return status;
}

export async function recordCurrentRunRuntimeProgress(
  db: Db,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "status">,
  update: RuntimeStatusUpdate,
  issueId: string | null,
) {
  if (!isHeartbeatRunRuntimeStatusActive(run.status)) {
    clearHeartbeatRunRuntimeStatus(run.id);
    return null;
  }
  const [currentRun] = await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
  ));
  if (!currentRun || !isHeartbeatRunRuntimeStatusActive(currentRun.status)) {
    clearHeartbeatRunRuntimeStatus(run.id);
    return null;
  }
  return recordHeartbeatRunRuntimeProgress(currentRun, update, issueId);
}
