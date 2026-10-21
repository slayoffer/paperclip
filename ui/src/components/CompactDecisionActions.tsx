import { Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttentionItem } from "@paperclipai/shared";
import { accessApi } from "../api/access";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { type InteractionAudienceDescription } from "../lib/interaction-audience";
import { interactionResolutionErrorMessage } from "../lib/interaction-resolution-error";
import { cn } from "../lib/utils";

export const ACTION_BTN = "h-9 gap-1.5 px-3 text-sm @xl:h-6 @xl:gap-1 @xl:px-2 @xl:text-xs";

export type CompactDecisionAction = "accept" | "approve" | "reject" | "request_revision";

export function compactDecisionAction(item: AttentionItem, verbId: string): CompactDecisionAction | null {
  if (item.sourceKind === "approval" && (verbId === "approve" || verbId === "reject" || verbId === "request_revision")) {
    return verbId;
  }
  if (item.sourceKind === "join_request" && (verbId === "approve" || verbId === "reject")) {
    return verbId;
  }
  if (
    item.sourceKind === "issue_thread_interaction"
    && item.subject.metadata?.kind === "request_confirmation"
    && (verbId === "accept" || verbId === "reject")
  ) {
    return verbId;
  }
  return null;
}

export const VERB_ORDER: Record<"outline" | "destructive" | "default", number> = {
  outline: 0,
  destructive: 1,
  default: 2,
};

export interface CompactAction {
  action: CompactDecisionAction;
  label: string;
  id: string;
  description: string;
}

export function collectCompactActions(item: AttentionItem): CompactAction[] {
  return item.decisionVerbs
    .slice(0, 3)
    .flatMap((verb) => {
      const action = compactDecisionAction(item, verb.id);
      return action ? [{ action, label: verb.label, id: verb.id, description: verb.description ?? "" }] : [];
    })
    .sort((a, b) => VERB_ORDER[decisionVerbVariant(a)] - VERB_ORDER[decisionVerbVariant(b)]);
}

export function CompactDecisionActions({
  item,
  companyId,
  audience,
  onOpen,
}: {
  item: AttentionItem;
  companyId: string;
  /** Effective resolver audience, so a denial can name who *can* respond. */
  audience: InteractionAudienceDescription | null;
  onOpen: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const actions = collectCompactActions(item);

  const decision = useMutation<unknown, Error, CompactDecisionAction>({
    mutationFn: (action: CompactDecisionAction) => {
      if (item.sourceKind === "approval") {
        if (action === "approve") return approvalsApi.approve(item.subject.id);
        if (action === "reject") return approvalsApi.reject(item.subject.id);
        return approvalsApi.requestRevision(item.subject.id);
      }
      if (item.sourceKind === "join_request") {
        return action === "approve"
          ? accessApi.approveJoinRequest(companyId, item.subject.id)
          : accessApi.rejectJoinRequest(companyId, item.subject.id);
      }
      if (item.sourceKind === "issue_thread_interaction") {
        const issueId = item.subject.metadata?.issueId;
        if (typeof issueId !== "string") throw new Error("Missing issue reference for this decision.");
        const revision = item.subject.metadata?.revision;
        if (typeof revision !== "string") throw new Error("Refresh this decision before answering.");
        if (action === "accept") return issuesApi.acceptInteraction(issueId, item.subject.id, { expectedRevision: revision });
        return issuesApi.rejectInteraction(issueId, item.subject.id, undefined, { expectedRevision: revision });
      }
      throw new Error("This decision must be completed from its detail view.");
    },
    onSuccess: (_result, action) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      if (item.sourceKind === "approval") {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      } else {
        queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
      }
      pushToast({
        title: compactDecisionSuccessLabel(item.sourceKind, action),
        tone: "success",
      });
    },
    onError: (error, action) => {
      // A policy denial is permanent, so it keeps the server's reason and names
      // the real responder instead of asking for a retry that will fail again.
      pushToast({
        title: `Could not ${decisionLabel(action)}`,
        body: interactionResolutionErrorMessage(error, audience),
        tone: "error",
      });
    },
  });

  if (actions.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-2 @xl:w-auto @xl:justify-end @xl:gap-1" aria-label="Decision actions">
      {actions.map(({ action, id, label, description }) => (
        <Button
          key={id}
          type="button"
          variant={decisionVerbVariant({ id, label, description })}
          size="xs"
          className={cn(ACTION_BTN, "min-w-0 flex-1 @xl:flex-none")}
          disabled={decision.isPending}
          onClick={(event) => {
            event.stopPropagation();
            if (item.sourceKind === "issue_thread_interaction" && action === "reject") {
              onOpen();
              return;
            }
            decision.mutate(action);
          }}
        >
          {decision.isPending && decision.variables === action && <Loader2 className="h-3 w-3 animate-spin" />}
          {label}
        </Button>
      ))}
    </div>
  );
}

export function decisionLabel(action: CompactDecisionAction): string {
  if (action === "request_revision") return "sent for revision";
  if (action === "accept" || action === "approve") return "approved";
  return "rejected";
}

export function compactDecisionSuccessLabel(sourceKind: AttentionItem["sourceKind"], action: CompactDecisionAction): string {
  if (sourceKind === "approval") return `Approval ${decisionLabel(action)}`;
  if (sourceKind === "join_request") return `Join request ${decisionLabel(action)}`;
  return action === "accept" ? "Confirmation accepted" : "Confirmation declined";
}

export function decisionVerbVariant(verb: AttentionItem["decisionVerbs"][number]): "default" | "outline" | "destructive" {
  const text = `${verb.label} ${verb.description ?? ""}`.toLowerCase();
  if (/\b(reject|decline|deny|delete|remove)\b/.test(text)) return "destructive";
  if (/\b(accept|approve|confirm|apply)\b/.test(text)) return "default";
  return "outline";
}
