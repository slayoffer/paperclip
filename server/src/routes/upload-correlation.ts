import type { Router, Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { uploadCorrelationQuerySchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { correlateUpload, emptyUploadCorrelation } from "../services/upload-correlation.js";
import { uploadReceiptService } from "../services/upload-receipts.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/access.js";

export function registerUploadCorrelation<Issue extends { id: string; companyId: string }>(router: Router, context: {
  db: Db;
  storage: StorageService;
  getIssue(req: Request, res: Response): Promise<Issue | null>;
  authorize(req: Request, res: Response, issue: Issue): Promise<boolean>;
}) {
  router.get("/companies/:companyId/issues/:issueId/attachment-upload-correlation", async (req, res) => {
    // Company access alone does not authorize receipt or object access.
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin || Boolean(req.actor.userId
      && await accessService(context.db).canUser(companyId, req.actor.userId, "audit:view_agent_actions"));
    if (!allowed) {
      res.status(403).json({ ...emptyUploadCorrelation(null, "Separate audit authority is required"), outcome: "access_denied" });
      return;
    }
    const issue = await context.getIssue(req, res);
    if (!issue || !await context.authorize(req, res, issue)) return;
    if (issue.companyId !== companyId) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const query = uploadCorrelationQuerySchema.parse(req.query);
    const result = await correlateUpload({ companyId, issueId: issue.id, query, authorized: true,
      repository: uploadReceiptService(context.db), storage: context.storage });
    res.setHeader("Cache-Control", "no-store");
    res.status(result.outcome === "access_denied" ? 403 : 200).json(result);
  });
}
