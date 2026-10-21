export type IssueListFilters = {
  attention?: "blocked";
  status?: string;
  projectId?: string;
  parentId?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  labelId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  descendantOf?: string;
  createdFromIssueId?: string;
  includeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated" | "id";
  afterId?: string;
  sortDir?: "asc" | "desc";
};

export function issueListSearchParams(filters?: IssueListFilters) {
  const params = new URLSearchParams();
  if (filters?.attention) params.set("attention", filters.attention);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.parentId) params.set("parentId", filters.parentId);
  if (filters?.assigneeAgentId)
    params.set("assigneeAgentId", filters.assigneeAgentId);
  if (filters?.participantAgentId)
    params.set("participantAgentId", filters.participantAgentId);
  if (filters?.assigneeUserId)
    params.set("assigneeUserId", filters.assigneeUserId);
  if (filters?.touchedByUserId)
    params.set("touchedByUserId", filters.touchedByUserId);
  if (filters?.inboxArchivedByUserId)
    params.set("inboxArchivedByUserId", filters.inboxArchivedByUserId);
  if (filters?.unreadForUserId)
    params.set("unreadForUserId", filters.unreadForUserId);
  if (filters?.labelId) params.set("labelId", filters.labelId);
  if (filters?.workspaceId) params.set("workspaceId", filters.workspaceId);
  if (filters?.executionWorkspaceId)
    params.set("executionWorkspaceId", filters.executionWorkspaceId);
  if (filters?.originKind) params.set("originKind", filters.originKind);
  if (filters?.originKindPrefix)
    params.set("originKindPrefix", filters.originKindPrefix);
  if (filters?.originId) params.set("originId", filters.originId);
  if (filters?.descendantOf) params.set("descendantOf", filters.descendantOf);
  if (filters?.createdFromIssueId) params.set("createdFromIssueId", filters.createdFromIssueId);
  if (filters?.includeRoutineExecutions)
    params.set("includeRoutineExecutions", "true");
  if (filters?.includeBlockedBy) params.set("includeBlockedBy", "true");
  if (filters?.includeBlockedInboxAttention)
    params.set("includeBlockedInboxAttention", "true");
  if (filters?.includeLiveDescendantSummary)
    params.set("includeLiveDescendantSummary", "true");
  if (filters?.hasPlanDocument !== undefined) {
    params.set("hasPlanDocument", filters.hasPlanDocument ? "true" : "false");
  }
  if (filters?.q) params.set("q", filters.q);
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.offset !== undefined)
    params.set("offset", String(filters.offset));
  if (filters?.sortField) params.set("sortField", filters.sortField);
  if (filters?.sortDir) params.set("sortDir", filters.sortDir);
  if (filters?.afterId) params.set("afterId", filters.afterId);
  return params;
}
