import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { publicationBindingsSchema, type PublicationDecision, type PublicationIdentity } from "@paperclipai/shared";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { publicationAuthorityService } from "./publication-authority.js";
import type { AuthorityClock } from "./publication-authority-context.js";
import { publicationTrust, type PublicationIssuer, type PublicationTrustReader } from "./publication-authority-trust.js";

export interface PublicationListenerOptions {
  enabled: true;
  db: Db;
  key: string | Buffer;
  cert: string | Buffer;
  issuers: readonly PublicationIssuer[];
  readTrust: PublicationTrustReader;
  clock?: AuthorityClock;
}

function reply(res: ServerResponse, status: number, decision: PublicationDecision) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(decision));
}
const denied = (reason: string): PublicationDecision => ({ dispatch: false, state: "denied", reason, remainingLifetimeMs: 0 });

async function readBindings(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) {
    throw new Error("Invalid content type");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return publicationBindingsSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** Isolated source prerequisite. Production startup never imports this factory.
 * No environment flag starts it. Only explicit protected construction can create a server.
 */
export function createPublicationAuthorityListener(options?: PublicationListenerOptions) {
  if (options?.enabled !== true) return null;
  const trust = publicationTrust(options.issuers, options.readTrust);
  const server = createServer({
    key: options.key, cert: options.cert, ca: options.issuers.map((issuer) => issuer.certificatePem),
    requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3",
    // A resumed handshake carries cached verification. This source listener refuses resumed sessions.
    sessionTimeout: 30,
  }, (req, res) => { void handle(req, res); });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 32;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const socket = req.socket;
      if (!(socket instanceof TLSSocket) || !socket.authorized || socket.isSessionReused()) {
        reply(res, 401, denied("certificate_required"));
        return;
      }
      // Proxy identity transfer is outside this direct-termination boundary.
      if (Object.keys(req.headers).some((key) => key.startsWith("x-") || key === "forwarded")) {
        reply(res, 400, denied("identity_headers_forbidden"));
        return;
      }
      const match = /^\/v1\/publication\/(request|dispatch|revoke|result\/(succeeded|refused|unknown))$/.exec(req.url ?? "");
      if (req.method !== "POST" || !match) {
        reply(res, 404, denied("route_unavailable"));
        return;
      }
      const raw = socket.getPeerCertificate().raw;
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const claims = token ? verifyLocalAgentJwt(token) : null;
      if (!raw || !claims || (claims.key_scope && claims.key_scope.kind !== "standard")) {
        reply(res, 401, denied("run_authentication_required"));
        return;
      }
      const peer = new X509Certificate(raw);
      const mapped = await options!.db.transaction((tx) => trust.registration(tx, peer));
      if (!mapped || claims.company_id !== mapped.record.companyId) {
        reply(res, 403, denied("registration_unavailable"));
        return;
      }
      const identity: PublicationIdentity = {
        companyId: mapped.record.companyId, brokerId: mapped.record.brokerId,
        certificateId: mapped.record.certificateId, issuerId: mapped.record.issuerId,
        agentId: claims.sub, runId: claims.run_id,
      };
      let bindings;
      try { bindings = await readBindings(req); }
      catch { reply(res, 400, denied("invalid_bindings")); return; }
      const service = publicationAuthorityService(options!.db, {
        clock: options!.clock,
        brokerGuard: async (tx, authenticated, now) => {
          // Recheck the signed run token after authority lock waits.
          const current = verifyLocalAgentJwt(token!);
          if (!current || current.sub !== identity.agentId || current.run_id !== identity.runId
            || current.company_id !== identity.companyId) return null;
          return trust.check(tx, peer, authenticated, now, mapped.record.hostId);
        },
      });
      const operation = match[1];
      const decision = operation === "request" ? await service.request(identity, bindings)
        : operation === "dispatch" ? await service.dispatch(identity, bindings)
          : operation === "revoke" ? await service.revoke(identity, bindings)
            : await service.recordResult(identity, bindings, z.enum(["succeeded", "refused", "unknown"]).parse(match[2]));
      reply(res, 200, decision);
    } catch {
      // A database or trust outage cannot become a cached permission. Do not expose tokens or database errors.
      if (!res.headersSent && !res.destroyed) reply(res, 503, denied("authority_unavailable"));
    }
  }
  return server;
}
