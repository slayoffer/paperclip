import { Link } from "@/lib/router";
import { EntityRow } from "@/components/EntityRow";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { Button } from "@/components/ui/button";
import { interactionReadinessRefetchInterval } from "@/lib/issue-thread-interactions";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Agent, CompanySkillTestRunDetail, IssueThreadInteraction, AskUserQuestionsInteraction, AskUserQuestionsAnswer } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { isInteractionAnswerable, routeInteraction } from "@/lib/skill-studio";

export const POLL_MS = 2000;

export function InteractionSection({
  companyId,
  detail,
  agents,
  onAnswered,
}: {
  companyId: string;
  detail: CompanySkillTestRunDetail;
  agents: Agent[];
  onAnswered: () => void;
}) {
  const harnessIssueId = detail.harnessIssue?.id ?? null;
  const hasInlineAnswerable = detail.interactions.some((i) => isInteractionAnswerable(i));

  // Only fetch the full interaction objects (needed to render answerable cards)
  // when there is at least one pending inline interaction on a live harness issue.
  const fullQuery = useQuery({
    queryKey: ["skill-studio", "interactions", harnessIssueId],
    queryFn: () => issuesApi.listInteractions(harnessIssueId!),
    enabled: Boolean(harnessIssueId && hasInlineAnswerable),
    refetchInterval: (query) => interactionReadinessRefetchInterval(query.state.data, hasInlineAnswerable ? POLL_MS : false),
  });
  const fullById = useMemo(
    () => new Map((fullQuery.data ?? []).map((i) => [i.id, i])),
    [fullQuery.data],
  );
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const accept = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; optionIds?: string[] }) =>
      issuesApi.acceptInteraction(harnessIssueId!, vars.interaction.id, {
        expectedRevision: vars.interaction.revision,
        selectedOptionIds: vars.optionIds,
      }),
    onSuccess: onAnswered,
  });
  const respond = useMutation({
    mutationFn: (vars: { interaction: AskUserQuestionsInteraction; answers: AskUserQuestionsAnswer[] }) =>
      issuesApi.respondToInteraction(harnessIssueId!, vars.interaction.id, { answers: vars.answers, expectedRevision: vars.interaction.revision }),
    onSuccess: onAnswered,
  });
  const reject = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; reason?: string }) =>
      issuesApi.rejectInteraction(harnessIssueId!, vars.interaction.id, vars.reason, { expectedRevision: vars.interaction.revision }),
    onSuccess: onAnswered,
  });

  if (detail.interactions.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Interactions
      </h3>
      <div className="space-y-2">
        {detail.interactions.map((summary) => {
          const inline = routeInteraction(summary.kind) === "inline";
          const full = fullById.get(summary.id);
          if (inline && full) {
            return (
              <IssueThreadInteractionCard
                key={summary.id}
                interaction={full}
                agentMap={agentMap}
                onAcceptInteraction={async (interaction, _keys, optionIds) => {
                  await accept.mutateAsync({ interaction, optionIds });
                }}
                onRejectInteraction={async (interaction, reason) => {
                  await reject.mutateAsync({ interaction, reason });
                }}
                onSubmitInteractionAnswers={async (interaction, answers) => {
                  await respond.mutateAsync({ interaction, answers });
                }}
              />
            );
          }
          // Fallback: summary row + open-test-task link (never dropped).
          return (
            <EntityRow
              key={summary.id}
              title={summary.title}
              subtitle={`${summary.kind} · ${summary.status}`}
              trailing={
                harnessIssueId ? (
                  <Button variant="link" size="xs" asChild>
                    <Link to={`/issues/${harnessIssueId}`}>Open test task ↗</Link>
                  </Button>
                ) : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}
