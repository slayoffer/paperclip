import { randomUUID } from "node:crypto";
import { request as plaintextRequest } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, publicationRequests } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createPublicationAuthorityListener } from "./publication-authority-listener.js";
import { startAuthorityDatabase } from "./publication-authority.test-fixture.js";
import { syntheticCertificates, transportFixture } from "./publication-authority-tls.test-fixture.js";

const path = (operation: string) => `/v1/publication/${operation}`;

describe("isolated mutual TLS publication authority", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  let material: ReturnType<typeof syntheticCertificates>;
  let f: Awaited<ReturnType<typeof transportFixture>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", `synthetic-${randomUUID()}`);
    material = syntheticCertificates();
    storage = await startAuthorityDatabase();
  }, 90_000);
  beforeEach(async () => { f = await transportFixture(storage.db, material); });
  afterEach(async () => { await f?.close(); });
  afterAll(async () => { await storage?.database.cleanup(); material?.dispose(); vi.unstubAllEnvs(); });

  it("binds a verified certificate and signed run to one durable dispatch", async () => {
    const client = f.client();
    expect((await client.post(path("request"))).decision).toMatchObject({ dispatch: false, state: "pending", reason: "recorded" });
    const initialSocket = client.socket;
    const decisions = await Promise.all([client.post(path("dispatch")), f.client().post(path("dispatch"))]);
    expect(decisions.filter((r) => r.decision.dispatch)).toHaveLength(1);
    expect(client.socket).toBe(initialSocket);
    expect((await client.post(path("result/succeeded"))).decision).toMatchObject({ dispatch: false, state: "succeeded" });
    expect((await client.post(path("dispatch"))).decision).toMatchObject({ dispatch: false, state: "succeeded" });
    expect((await client.post(path("request"))).decision).toMatchObject({ dispatch: false, state: "succeeded", reason: "replay" });
    const audits = await storage.db.select().from(activityLog).where(eq(activityLog.entityId, f.bindings.requestId));
    expect(audits.map((row) => row.action)).toEqual(["publication.requested", "publication.dispatched", "publication.result_succeeded"]);
  });

  it("rejects an issuer outside the explicit trust bundle", async () => {
    await expect(f.client(material.other).post(path("request"))).rejects.toThrow();
    expect(await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId))).toHaveLength(0);
  });

  it("rejects a trusted but unregistered certificate", async () => {
    expect(await f.client(material.unknown).post(path("request"))).toMatchObject({ status: 403, decision: { dispatch: false } });
  });

  it("requires a client certificate with the client authentication purpose", async () => {
    await expect(f.client(null).post(path("request"))).rejects.toThrow();
    await expect(f.client(material.wrongPurpose).post(path("request"))).rejects.toThrow();
  });

  it("makes the broker verify the authority certificate and expected server identity", async () => {
    await expect(f.client(material.broker, { servername: "wrong.synthetic" }).post(path("request"))).rejects.toThrow();
    await expect(f.client(material.broker, { ca: material.otherCa }).post(path("request"))).rejects.toThrow();
  });

  it.each(["companyId", "brokerId", "agentId", "runId"])("rejects the caller's altered %s", async (field) => {
    const response = await f.client().post(path("request"), { ...f.bindings, [field]: randomUUID() });
    expect(response.decision).toMatchObject({ dispatch: false, reason: "identity_mismatch" });
  });

  it("requires a signed run independently of the broker certificate", async () => {
    const client = f.client();
    for (const authorization of ["", "Bearer fabricated", `Bearer ${f.token.slice(0, -5)}AAAAA`]) {
      expect(await client.post(path("request"), f.bindings, { Authorization: authorization })).toMatchObject({ status: 401 });
    }
    const foreign = createLocalAgentJwt(f.identity.agentId, randomUUID(), "codex_local", f.identity.runId)!;
    expect(await client.post(path("request"), f.bindings, { Authorization: `Bearer ${foreign}` })).toMatchObject({ status: 403 });
    const otherRun = createLocalAgentJwt(f.identity.agentId, f.identity.companyId, "codex_local", randomUUID())!;
    expect((await client.post(path("request"), f.bindings, { Authorization: `Bearer ${otherRun}` })).decision.dispatch).toBe(false);
    const restricted = createLocalAgentJwt(f.identity.agentId, f.identity.companyId, "codex_local", f.identity.runId,
      null, { kind: "skill_test", issueId: f.bindings.issueId })!;
    expect(await client.post(path("request"), f.bindings, { Authorization: `Bearer ${restricted}` })).toMatchObject({ status: 401 });
  });

  it.each(["X-Broker-Id", "X-Company-Id", "X-Paperclip-Run-Id", "X-Forwarded-Client-Cert", "Forwarded"])(
    "rejects caller identity header %s", async (header) => {
      expect(await f.client().post(path("request"), f.bindings, { [header]: f.identity.brokerId })).toMatchObject({
        status: 400, decision: { dispatch: false, reason: "identity_headers_forbidden" },
      });
    });

  it("rejects unknown fields and leaves the accepted operation schema intact", async () => {
    expect(await f.client().post(path("request"), { ...f.bindings, hostId: "caller-host" })).toMatchObject({ status: 400 });
    expect(await f.client().post(path("request"), { ...f.bindings, operation: "merge" })).toMatchObject({ status: 400 });
    expect(await f.client().post(path("request"), f.bindings, { "Content-Type": "text/plain" })).toMatchObject({ status: 400 });
    expect(await f.client().post(path("request"), { padding: "a".repeat(20_000) })).toMatchObject({ status: 400 });
    expect(await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId))).toHaveLength(0);
  });

  it("exposes no plaintext or ordinary application route", async () => {
    for (const route of ["/api/publication/dispatch", "/api/v1/publication/dispatch", "/v1/publication/reconcile"]) {
      expect(await f.client().post(route)).toMatchObject({ status: 404, decision: { dispatch: false } });
    }
    const address = f.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP fixture");
    await f.client().post(path("request"));
    await expect(new Promise((resolve, reject) => {
      const req = plaintextRequest({ hostname: "127.0.0.1", port: address.port, path: path("dispatch"), method: "POST" }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on("error", reject);
      req.setTimeout(2_000, () => req.destroy(new Error("Plaintext fixture timeout")));
      req.end(JSON.stringify(f.bindings));
    })).rejects.toThrow();
    expect(await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId)))
      .toMatchObject([{ state: "pending", dispatchedAtMs: null }]);
  });

  it("keeps production startup disconnected and construction disabled by default", () => {
    expect(createPublicationAuthorityListener()).toBeNull();
    const environment = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(createPublicationAuthorityListener({
        enabled: true, db: storage.db, key: material.server.key, cert: material.server.cert,
        issuers: [{ id: f.identity.issuerId, certificatePem: material.ca }],
        readTrust: async () => f.snapshot,
      })).toBeNull();
    } finally { vi.stubEnv("NODE_ENV", environment); }
    const sourceRoot = new URL("../", import.meta.url);
    const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true });
    const consumers = files.filter((file) => file.isFile() && file.name.endsWith(".ts")
      && !file.name.includes(".test") && file.name !== "publication-authority-listener.ts")
      .filter((file) => readFileSync(join(file.parentPath, file.name), "utf8").includes("publication-authority-listener"));
    expect(consumers.map((file) => file.name)).toEqual([]);
  });
});
