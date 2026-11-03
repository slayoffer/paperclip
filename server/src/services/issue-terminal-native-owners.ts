import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { evaluateNativeProviderProcesses, type NativeProviderProcessIdentity } from "./native-runtime/native-restart-recovery.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function hasRetainedNativeProvider(
  db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "runtimeMode" | "runnerProfileJson" | "contextSnapshot">,
): Promise<boolean> {
  if (run.runtimeMode !== "native") return false;
  const profile = record(run.runnerProfileJson);
  const environment = record(run.contextSnapshot?.paperclipEnvironment);
  // Remote process IDs do not identify processes on this host.
  if (profile.nativeWorkspaceSync != null || environment.driver !== "local") return false;
  const process = record(record(profile.sessionCheckpoint).process);
  const identities: NativeProviderProcessIdentity[] = [];
  const add = (pid: unknown, startedAt: unknown) => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
    const parsed = typeof startedAt === "string" ? new Date(startedAt) : null;
    identities.push({ pid, processStartedAt: parsed && Number.isFinite(parsed.getTime()) ? parsed : null });
  };
  for (const prefix of ["provider", "codex", "sidecar", "agent"]) {
    add(process[`${prefix}Pid`], process[`${prefix}ProcessStartedAt`]);
  }
  const events = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, ["harness.ready", "session.started", "session.resumed", "session.updated",
      "turn.started", "provider.event", "provider.rpc_result"]),
  ));
  for (const event of events) {
    const payload = record(record(event.payload?.prpEvent).payload);
    add(payload.processId, payload.processStartedAt ?? payload.providerProcessStartedAt);
  }
  // Use restart recovery's start-time check. A recycled PID is not an owner;
  // an existing provider whose identity cannot be disproved still protects files.
  const result = await evaluateNativeProviderProcesses({ identities });
  return result.livePids.length > 0 || result.ambiguousLivePids.length > 0;
}
