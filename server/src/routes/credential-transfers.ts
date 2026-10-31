import { Router } from "express";
import { z } from "zod";
import { createCredentialTransferSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { assertBoardOrAgent, assertCompanyAccess } from "./authz.js";
import { CredentialTransferError, type credentialTransferService, type TransferActor } from "../services/credential-transfer.js";
import { logActivity } from "../services/activity-log.js";

/**
 * The application passes the production adapter factory. Without a qualified provider registry it refuses
 * every transfer with `provider_guarantees_unqualified` before any gateway or provider call.
 */
export function credentialTransferRoutes(db: Db, options: {
  serviceForRequest?: (sessionToken: string) => Pick<ReturnType<typeof credentialTransferService>, "execute">;
  audit?: typeof logActivity;
} = {}) {
  const router = Router();
  router.post("/companies/:companyId/credential-transfers", async (req, res) => {
    assertBoardOrAgent(req);
    const company = z.string().uuid().safeParse(req.params.companyId);
    if (!company.success) throw new CredentialTransferError(400, "company_invalid");
    assertCompanyAccess(req, company.data);
    // Agent and responsible person come from authenticated context, never request parameters.
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.onBehalfOfUserId
      || !req.actor.onBehalfOfMemberships?.some(m => m.companyId === company.data && m.status === "active" && m.membershipRole !== "viewer")) {
      throw new CredentialTransferError(403, "transfer_identity_required");
    }
    const parsed = createCredentialTransferSchema.safeParse(req.body);
    if (!parsed.success) throw new CredentialTransferError(400, "request_invalid");
    const sessionToken = req.header("x-paperclip-tool-gateway-token");
    if (!sessionToken) throw new CredentialTransferError(403, "gateway_session_required");
    if (!options.serviceForRequest) throw new CredentialTransferError(503, "transfer_provider_unavailable");
    const actor: TransferActor = { companyId: company.data, issueId: parsed.data.issueId,
      agentId: req.actor.agentId, userId: req.actor.onBehalfOfUserId };
    try {
      const result = await options.serviceForRequest(sessionToken).execute(actor, parsed.data);
      await (options.audit ?? logActivity)(db, { companyId: company.data, actorType: "agent", actorId: actor.agentId,
        agentId: actor.agentId, runId: req.actor.runId, action: "credential_transfer.settled", entityType: "credential_transfer",
        entityId: result.id, details: { state: result.state, failureCode: result.failureCode } });
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof CredentialTransferError) throw error;
      throw new CredentialTransferError(500, "transfer_failed");
    }
  });
  return router;
}
