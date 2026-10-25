import { z } from "zod";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";

const deadlineSchema = z.iso.datetime({ offset: true });
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** Keep the deadline in the action, where the external watchdog reads it. */
export function externalWaitDeadline(descriptor: IssueUnblockDescriptor | null | undefined): number | null {
  if (descriptor?.kind !== "external" || descriptor.owner !== "board") return null;
  const deadlines = [...descriptor.action.matchAll(/\bdeadline:[ \t]*(\S+)/gi)];
  if (deadlines.length !== 1 || !deadlineSchema.safeParse(deadlines[0][1]).success) return null;
  return Date.parse(deadlines[0][1]);
}

export function assertAssigneeExternalWait(
  issue: { assigneeAgentId: string | null },
  actorAgentId: string | undefined,
  update: { assigneeAgentId?: string | null },
  descriptor: IssueUnblockDescriptor,
) {
  const nextAssignee = update.assigneeAgentId === undefined ? issue.assigneeAgentId : update.assigneeAgentId;
  if (!actorAgentId || issue.assigneeAgentId !== actorAgentId || nextAssignee !== actorAgentId) {
    throw forbidden("Only the unchanged issue assignee can declare this external wait");
  }
  const deadline = externalWaitDeadline(descriptor);
  const remaining = deadline === null ? 0 : deadline - Date.now();
  if (remaining <= 0 || remaining > MAX_WAIT_MS) {
    throw unprocessable("An external wait requires one future ISO deadline within seven days in action");
  }
}
