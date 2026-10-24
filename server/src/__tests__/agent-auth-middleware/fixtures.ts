import { createHash, createHmac } from "node:crypto";
import express from "express";
import {
  activityLog,
  agentApiKeys,
  agents,
  boardApiKeys,
  heartbeatRuns,
} from "@paperclipai/db";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { assertCompanyAccess } from "../../routes/authz.js";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(
  rowsForTable: (table: unknown) => unknown[],
  selection?: Record<string, unknown>,
) {
  return {
    from(table: unknown) {
      return {
        where() {
          const rows = rowsForTable(table);
          return Promise.resolve(selection
            ? rows.map((row) => Object.fromEntries(Object.keys(selection).map((key) => [
                key, (row as Record<string, unknown>)[key],
              ])))
            : rows);
        },
      };
    },
  };
}

export function createDbState(input: {
  agent: { id: string; companyId: string; status?: string };
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null };
  run?: { id: string; companyId: string; agentId: string; responsibleUserId?: string | null;
    status?: string; contextSnapshot?: Record<string, unknown>; resultJson?: Record<string, unknown> };
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
        status: input.run.status ?? "running",
        // Match the stored scalar columns from migration 0308.
        writesRevoked: input.run.status === "cancelled"
          || (input.run.resultJson?.executionCancellation as { state?: string } | undefined)?.state === "requested",
        conversationMode: input.run.contextSnapshot?.conversationMode === true,
        contextSnapshot: input.run.contextSnapshot ?? {},
        resultJson: input.run.resultJson ?? {},
      }
    : null;

  const db = {
    select: (selection?: Record<string, unknown>) =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        return [];
      }, selection),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

export function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.post("/api/routine-triggers/public/:publicId/fire", (req, res) => {
    res.json({ reachedWebhook: true, actorType: req.actor.type });
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayProtocol: true, actorType: req.actor.type });
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, writable: true });
  });
  app.use(errorHandler);
  return app;
}

export function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
  expiresInSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + (input.expiresInSeconds ?? 3600),
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}
