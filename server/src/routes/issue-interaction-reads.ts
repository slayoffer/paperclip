import type { Request, Response, Router } from "express";
import type { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

type InteractionService = ReturnType<typeof issueThreadInteractionService>;
type IssueScope = { id: string; companyId: string };

/** Use the issue route's access checks before reading saved evidence. */
export function registerIssueInteractionReads<Issue extends IssueScope>(
  router: Router,
  context: {
    getIssue: (req: Request, res: Response) => Promise<Issue | null>;
    authorize: (req: Request, res: Response, issue: Issue) => Promise<boolean>;
    service: Pick<InteractionService, "listForIssue" | "getForIssue">;
  },
) {
  router.get("/issues/:id/interactions", async (req, res) => {
    const issue = await context.getIssue(req, res);
    if (!issue || !(await context.authorize(req, res, issue))) return;
    const interactions = await context.service.listForIssue(issue.id);
    res.json(interactions.filter((card) => card.companyId === issue.companyId && card.issueId === issue.id));
  });

  router.get("/issues/:id/interactions/:interactionId", async (req, res) => {
    const issue = await context.getIssue(req, res);
    if (!issue || !(await context.authorize(req, res, issue))) return;
    res.json(await context.service.getForIssue(issue, req.params.interactionId as string));
  });
}
