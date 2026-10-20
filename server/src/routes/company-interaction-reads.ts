import type { Request, Response, Router } from "express";
import { isUuidLike, listCompanyInteractionsQuerySchema } from "@paperclipai/shared";
import type { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

type InteractionService = ReturnType<typeof issueThreadInteractionService>;
type ReadableIssue = Parameters<Parameters<InteractionService["listForCompany"]>[2]>[0];

export function registerCompanyInteractionReads<Issue extends { id: string; companyId: string }>(
  router: Router,
  context: {
    service: Pick<InteractionService, "listForCompany" | "getById">;
    assertCompanyAccess: (req: Request, companyId: string) => void;
    companyScope: (req: Request, companyId: string) => Promise<boolean>;
    canReadIssue: (req: Request, issue: ReadableIssue) => Promise<boolean>;
    getIssue: (req: Request, res: Response, id: string) => Promise<Issue | null>;
    authorize: (req: Request, res: Response, issue: Issue) => Promise<boolean>;
  },
) {
  router.get("/companies/:companyId/interactions", async (req, res) => {
    const companyId = req.params.companyId as string;
    context.assertCompanyAccess(req, companyId);
    const parsed = listCompanyInteractionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid interaction query" });
      return;
    }
    const companyScope = await context.companyScope(req, companyId);
    const page = await context.service.listForCompany(
      companyId,
      parsed.data,
      async (issue) => companyScope || (await context.canReadIssue(req, issue)),
    );
    res.json(page);
  });

  // Exact-id card lookup: which issue owns this interaction. Lets a client open a card from its id without
  // scanning issues. The response is a fixed v1 shape; unknown, foreign-company and unreadable ids are all 404.
  router.get("/companies/:companyId/interaction-locations/:interactionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const interactionId = req.params.interactionId as string;
    context.assertCompanyAccess(req, companyId);
    if (!isUuidLike(interactionId)) {
      res.status(404).json({ error: "Interaction not found" });
      return;
    }
    const interaction = await context.service.getById(interactionId);
    if (!interaction || interaction.companyId !== companyId) {
      res.status(404).json({ error: "Interaction not found" });
      return;
    }
    const issue = await context.getIssue(req, res, interaction.issueId);
    if (!issue) return;
    if (!(await context.authorize(req, res, issue))) return;
    res.json({ version: 1, companyId, interactionId: interaction.id, issueId: issue.id });
  });
}
