import express from "express";
import request from "supertest";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { credentialTransferRoutes } from "../routes/credential-transfers.js";
import { credentialTransferServiceFactory } from "../services/credential-transfer-providers.js";
import { errorHandler } from "../middleware/error-handler.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { transferFixture, CANARIES } from "./helpers/credential-transfer-fixture.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function setup(mode: "enabled" | "disabled" = "enabled") {
  const f = transferFixture();
  const audit = vi.fn().mockResolvedValue(undefined);
  let actor: Express.Request["actor"] = { type: "agent", source: "agent_jwt", agentId: f.actor.agentId,
    companyId: f.actor.companyId, onBehalfOfUserId: f.actor.userId,
    onBehalfOfMemberships: [{ companyId: f.actor.companyId, status: "active", membershipRole: "owner" }] };
  const app = express();
  const logs: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { logs.push(chunk.toString()); callback(); } });
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, output)));
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", credentialTransferRoutes({} as Db, {
    ...(mode === "enabled" ? { serviceForRequest: () => f.createService() } : {}), audit,
  }));
  app.use(errorHandler);
  // Some workers have no IPv6 loopback. Await the IPv4 bind before Supertest reads the address.
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const path = `/api/companies/${f.actor.companyId}/credential-transfers`;
  const send = (body: unknown = f.request) => request(server).post(path).set("x-paperclip-tool-gateway-token", CANARIES[0]!).send(body);
  return { f, server, path, send, audit, logs, setActor(value: typeof actor) { actor = value; } };
}

describe("credential transfer route", () => {
  it("returns only identifiers and fixed state, and records a redacted activity", async () => {
    const s = await setup();
    const response = await s.send().expect(201);
    expect(response.body.state).toBe("complete");
    expect(s.audit).toHaveBeenCalledOnce();
    for (const value of CANARIES) expect(JSON.stringify([response.body, s.audit.mock.calls, s.logs])).not.toContain(value);
  });
  it("rejects a caller from another company before any provider call", async () => {
    const s = await setup();
    s.setActor({ type: "agent", source: "agent_jwt", agentId: s.f.actor.agentId, companyId: s.f.request.issueId });
    await s.send().expect(403);
    expect(s.f.trace).toEqual([]);
  });
  it("rejects missing personal identity or membership without an administrator fallback", async () => {
    const s = await setup();
    s.setActor({ type: "agent", source: "agent_jwt", agentId: s.f.actor.agentId, companyId: s.f.actor.companyId });
    await s.send().expect(403);
    s.setActor({ type: "board", source: "local_implicit", userId: s.f.actor.userId, isInstanceAdmin: true });
    await s.send().expect(403);
    expect(s.f.issueCount).toBe(0);
  });
  it("rejects missing gateway authority", async () => {
    const s = await setup();
    await request(s.server).post(s.path).send(s.f.request).expect(403);
    expect(s.f.trace).toEqual([]);
  });
  it("rejects unapproved fields and raw secret inputs without echoing them", async () => {
    const s = await setup();
    const response = await s.send({ ...s.f.request, unexpected: CANARIES[1] }).expect(400);
    for (const value of CANARIES) expect(JSON.stringify([response.body, s.logs])).not.toContain(value);
    expect(s.f.trace).toEqual([]);
    expect(isSecretSensitiveHttpRequest("POST", s.path)).toBe(true);
    expect(isSecretSensitiveHttpRequest("PUT", `http://localhost${s.path.toUpperCase()}`)).toBe(true);
  });
  it("keeps the application default incapable of live issuance", async () => {
    const s = await setup("disabled");
    await s.send().expect(503);
    expect(s.f.trace).toEqual([]);
  });
  it("refuses every transfer through the production factory while provider guarantees are unqualified", async () => {
    const f = transferFixture();
    const gateway = { authorizeCredentialTransfer: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "agent", source: "agent_jwt", agentId: f.actor.agentId,
      companyId: f.actor.companyId, onBehalfOfUserId: f.actor.userId,
      onBehalfOfMemberships: [{ companyId: f.actor.companyId, status: "active", membershipRole: "owner" }] }; next(); });
    app.use("/api", credentialTransferRoutes({} as Db, { serviceForRequest: credentialTransferServiceFactory({} as Db, gateway) }));
    app.use(errorHandler);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const response = await request(server).post(`/api/companies/${f.actor.companyId}/credential-transfers`)
      .set("x-paperclip-tool-gateway-token", CANARIES[0]!).send(f.request).expect(422);
    expect(response.body).toMatchObject({ code: "provider_guarantees_unqualified" });
    expect(gateway.authorizeCredentialTransfer).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(CANARIES[0]);
  });
  it("redacts parser errors before the route reads the request", async () => {
    const s = await setup();
    const response = await request(s.server).post(s.path).set("content-type", "application/json")
      .set("x-paperclip-tool-gateway-token", CANARIES[0]!).send(`{"unexpected":"${CANARIES[1]}" invalid`).expect(400);
    for (const value of CANARIES) expect(JSON.stringify([response.body, s.logs])).not.toContain(value);
    expect(s.f.trace).toEqual([]);
  });
  it("redacts ambiguous provider failure responses", async () => {
    const s = await setup();
    s.f.setFailure("issue");
    const response = await s.send().expect(201);
    expect(response.body.state).toBe("revoked");
    for (const value of CANARIES) expect(JSON.stringify([response.body, s.audit.mock.calls, s.logs])).not.toContain(value);
  });
});
