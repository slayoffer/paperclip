import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { runStatsQuerySchema } from "@paperclipai/shared/run-stats";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { runStatsService } from "../services/run-stats.js";
import { assertCompanyAccess } from "./authz.js";

export function runStatsRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const stats = runStatsService(db);
  router.get("/companies/:companyId/run-stats", async (req, res) => {
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent" && (!req.actor.agentId
      || !await access.hasPermission(companyId, "agent", req.actor.agentId, "stats:read"))) {
      throw forbidden("Run statistics require stats:read.");
    }
    const query = runStatsQuerySchema.parse(req.query);
    res.set("Cache-Control", "no-store");
    res.json(await stats.report(companyId, query));
  });
  return router;
}
