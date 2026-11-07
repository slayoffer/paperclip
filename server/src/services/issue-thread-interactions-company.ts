import { and, asc, eq, gt, inArray, notInArray, or } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import type { CompanyIssueThreadInteractionPage, ListCompanyInteractionsQuery, IssueThreadInteraction } from "@paperclipai/shared";

type InteractionRow = typeof issueThreadInteractions.$inferSelect;

export function createCompanyInteractionReader(db: Db, context: {
  hydrateInteraction: (row: InteractionRow) => IssueThreadInteraction;
  isTerminalIssueStatus: (status: string) => boolean;
  buildAdministrativeOutcomeResult: (row: InteractionRow, outcome: "issue_closed") => InteractionRow["result"];
  withAcceptanceReadiness: (items: IssueThreadInteraction[], issue: { companyId: string; executionWorkspaceId: string | null }) => Promise<IssueThreadInteraction[]>;
}) {
  const { hydrateInteraction, isTerminalIssueStatus, buildAdministrativeOutcomeResult, withAcceptanceReadiness } = context;
  return async (
      companyId: string,
      filters: ListCompanyInteractionsQuery,
      canReadIssue: (issue: Pick<
        typeof issues.$inferSelect,
        "id" | "companyId" | "projectId" | "parentId" | "assigneeAgentId" |
        "assigneeUserId" | "status"
      >) => Promise<boolean>,
    ): Promise<CompanyIssueThreadInteractionPage> => {
      const issueFields = {
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
        executionWorkspaceId: issues.executionWorkspaceId,
      };
      // Match listForIssue's virtual expiry without changing stored interactions.
      const terminal = inArray(issues.status, ["done", "cancelled"]);
      const statusFilter = filters.status === "pending"
        ? and(
            eq(issueThreadInteractions.status, "pending"),
            notInArray(issues.status, ["done", "cancelled"]),
          )
        : filters.status === "expired"
          ? or(
              eq(issueThreadInteractions.status, "expired"),
              and(eq(issueThreadInteractions.status, "pending"), terminal),
            )
          : filters.status ? eq(issueThreadInteractions.status, filters.status) : undefined;
      const readBatch = (cursor?: string) => db
        .select({ interaction: issueThreadInteractions, issue: issueFields })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issues.companyId, companyId),
          statusFilter,
          filters.kind ? eq(issueThreadInteractions.kind, filters.kind) : undefined,
          filters.issueId ? eq(issueThreadInteractions.issueId, filters.issueId) : undefined,
          cursor ? gt(issueThreadInteractions.id, cursor) : undefined,
        ))
        .orderBy(asc(issueThreadInteractions.id))
        .limit(filters.limit + 1);
      const visible: Awaited<ReturnType<typeof readBatch>> = [];
      const accessByIssue = new Map<string, boolean>();
      let scanCursor = filters.cursor;
      // Scan past inaccessible rows before pagination. Never expose their cursors.
      while (visible.length <= filters.limit) {
        const rows = await readBatch(scanCursor);
        for (const row of rows) {
          let allowed = accessByIssue.get(row.issue.id);
          if (allowed === undefined) {
            allowed = await canReadIssue(row.issue);
            accessByIssue.set(row.issue.id, allowed);
          }
          if (allowed) visible.push(row);
          if (visible.length > filters.limit) break;
        }
        if (visible.length > filters.limit || rows.length < filters.limit + 1) break;
        scanCursor = rows[rows.length - 1]!.interaction.id;
      }
      const page = visible.slice(0, filters.limit);
      const byIssue = new Map<string, {
        issue: (typeof page)[number]["issue"];
        items: IssueThreadInteraction[];
      }>();
      for (const { interaction: row, issue } of page) {
        const group = byIssue.get(issue.id) ?? { issue, items: [] };
        group.items.push(hydrateInteraction(
          isTerminalIssueStatus(issue.status) && row.status === "pending"
            ? {
                ...row,
                status: "expired",
                result: buildAdministrativeOutcomeResult(row, "issue_closed"),
                resolvedAt: row.updatedAt,
              }
            : row,
        ));
        byIssue.set(issue.id, group);
      }
      const hydrated = new Map<string, IssueThreadInteraction>();
      await Promise.all([...byIssue.values()].map(async ({ issue, items }) => {
        for (const item of await withAcceptanceReadiness(items, issue)) {
          hydrated.set(item.id, item);
        }
      }));
      return {
        items: page.map(({ interaction, issue }) => ({
          ...hydrated.get(interaction.id)!,
          issueIdentifier: issue.identifier,
        })),
        nextCursor: visible.length > filters.limit ? page[page.length - 1]!.interaction.id : null,
      };
    };
}
