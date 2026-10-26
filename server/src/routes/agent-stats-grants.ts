import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { grantAgentStatsReadSchema } from "@paperclipai/shared/run-stats";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { grantAgentStatsRead } from "../services/agent-stats-grants.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentStatsGrantRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  router.post("/companies/:companyId/agents/:agentId/permission-grants", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    const agentId = z.string().uuid().parse(req.params.agentId);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "users:manage_permissions",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) throw forbidden("Permission denied");
    grantAgentStatsReadSchema.parse(req.body);
    res.json(await grantAgentStatsRead(db, companyId, agentId, req.actor.userId ?? null));
  });
  return router;
}
