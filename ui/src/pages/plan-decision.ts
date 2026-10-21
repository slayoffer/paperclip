import { type IssueThreadInteraction, type RequestConfirmationInteraction } from "@paperclipai/shared";

export function isPlanConfirmationInteraction(
  interaction: IssueThreadInteraction,
): interaction is RequestConfirmationInteraction {
  return (
    interaction.kind === "request_confirmation" &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan"
  );
}

export function buildPlanDecisionResponseText(
  interaction: RequestConfirmationInteraction,
) {
  if (interaction.status === "accepted") return "Approved plan";
  const reason = interaction.result?.reason?.trim();
  return reason ? `Requested changes\n\n${reason}` : "Requested changes";
}
