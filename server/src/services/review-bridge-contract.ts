import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, type Db, issues } from "@paperclipai/db";
import { reviewBridgeTargetSchema, type IssueUnblockDescriptor } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { hasSavedReviewWait } from "./review-wait.js";

export type BridgeTarget = NonNullable<IssueUnblockDescriptor["bridge"]>;
export type BridgeWait = IssueUnblockDescriptor & { kind: "review_bridge"; until: string; bridge: BridgeTarget };
export const bridgeWaitKey = (issueId: string, waitId: string) => `review-bridge:${issueId}:${waitId}`;

export function isReviewBridgeWait(value: IssueUnblockDescriptor | null | undefined): value is BridgeWait {
  return value?.kind === "review_bridge" && Boolean(value.until && Number.isFinite(Date.parse(value.until)))
    && reviewBridgeTargetSchema.safeParse(value.bridge).success;
}

/** A structured event releases one wait. It grants no merge or execution authority. */
export function parseBridgeEvent(body: string): BridgeTarget | null {
  const blocks: string[] = [];
  let fence: { marker: string; length: number; event: boolean; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
        if (fence.event) blocks.push(fence.lines.join("\n"));
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (opening) fence = { marker: opening[2][0], length: opening[2].length,
      event: opening[1] === "" && opening[2] === "```" && opening[3].trim() === "bridge-event", lines: [] };
  }
  if (fence?.event || blocks.length !== 1) return null;
  try {
    const event = reviewBridgeTargetSchema.safeParse(JSON.parse(blocks[0]));
    return event.success ? event.data : null;
  } catch { return null; }
}

export function bridgeEventMatches(wait: BridgeWait, body: string): boolean {
  const event = parseBridgeEvent(body);
  return Boolean(event && event.waitId === wait.bridge.waitId && event.repo === wait.bridge.repo
    && event.head === wait.bridge.head && event.stage === wait.bridge.stage && event.pr === wait.bridge.pr);
}

export async function assertReviewBridgeWait(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier" | "assigneeAgentId">,
  actor: Express.Request["actor"],
  update: { assigneeAgentId?: string | null },
  descriptor: IssueUnblockDescriptor,
) {
  if (!isReviewBridgeWait(descriptor)) throw unprocessable("A bridge wait requires a target and expiry");
  const remaining = Date.parse(descriptor.until) - Date.now();
  if (remaining <= 0 || remaining > 7 * 24 * 60 * 60 * 1000) {
    throw unprocessable("A bridge wait must expire within seven days");
  }
  const owner = update.assigneeAgentId === undefined ? issue.assigneeAgentId : update.assigneeAgentId;
  if (!owner || (actor.type === "agent" && (actor.agentId !== issue.assigneeAgentId || actor.agentId !== owner))) {
    throw forbidden("Only the issue owner or board can declare this wait");
  }
  if (descriptor.owner !== "board" && (!("agentId" in descriptor.owner) || descriptor.owner.agentId !== owner)) {
    throw unprocessable("A bridge wait must name the board or assigned owner");
  }
  if (!await hasSavedReviewWait(db, { ...issue, assigneeAgentId: owner }, owner, descriptor)) {
    throw unprocessable("A bridge wait requires the latest saved owner handoff for this repository and head");
  }
  const [used] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId),
    eq(agentWakeupRequests.idempotencyKey, bridgeWaitKey(issue.id, descriptor.bridge.waitId)),
  )).limit(1);
  if (used) throw unprocessable("This bridge wait identifier is complete. Use a new identifier");
}
