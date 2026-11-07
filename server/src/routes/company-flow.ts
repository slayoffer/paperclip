import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyFlowService } from "../services/company-flow.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function companyFlowRoutes(db: Db) {
  const router = Router();
  const service = companyFlowService(db);
  router.get("/companies/:companyId/flow", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await service.report(companyId));
  });
  return router;
}
