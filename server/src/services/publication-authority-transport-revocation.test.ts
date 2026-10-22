import { randomUUID, X509Certificate } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publicationAuthorityClocks, publicationBrokers, publicationRequests, issues } from "@paperclipai/db";
import { publicationDispatchWithinDeadline } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { barrier, startAuthorityDatabase, waitForDatabaseWait } from "./publication-authority.test-fixture.js";
import { certificateFingerprint } from "./publication-authority-trust.js";
import { syntheticCertificates, transportFixture } from "./publication-authority-tls.test-fixture.js";

const path = (operation: string) => `/v1/publication/${operation}`;

describe("current transport authorization on established connections", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  let material: ReturnType<typeof syntheticCertificates>;
  let f: Awaited<ReturnType<typeof transportFixture>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", `synthetic-${randomUUID()}`);
    material = syntheticCertificates();
    storage = await startAuthorityDatabase();
  }, 90_000);
  beforeEach(async () => { f = await transportFixture(storage.db, material); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); });
  afterAll(async () => { await storage?.database.cleanup(); material?.dispose(); vi.unstubAllEnvs(); });

  it.each(["broker", "issuer", "certificate", "assignment"])("applies current %s revocation to the same connection", async (kind) => {
    const client = f.client();
    await client.post(path("request"));
    const socket = client.socket;
    if (kind === "broker") await storage.db.update(publicationBrokers).set({ revokedAt: new Date() })
      .where(eq(publicationBrokers.id, f.identity.brokerId));
    if (kind === "issuer") await storage.db.update(publicationBrokers).set({ issuerRevoked: true })
      .where(eq(publicationBrokers.issuerId, f.identity.issuerId));
    if (kind === "certificate") f.setTrust({ ...f.snapshot, registrations: [{ ...f.registration, state: "revoked" }] });
    if (kind === "assignment") await storage.db.update(issues).set({ assigneeAgentId: null })
      .where(eq(issues.id, f.bindings.issueId));
    expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
    expect(client.socket).toBe(socket);
  });

  it("refuses a resumed TLS session after certificate revocation", async () => {
    const client = f.client();
    await client.post(path("request"));
    expect(client.session).toBeInstanceOf(Buffer);
    const session = client.session!;
    const reused: boolean[] = [];
    f.server.on("secureConnection", (socket) => reused.push(socket.isSessionReused()));
    f.setTrust({ ...f.snapshot, registrations: [{ ...f.registration, state: "revoked" }] });
    const resumed = f.client(material.broker, { session });
    const response = await resumed.post(path("dispatch"));
    expect(reused).toEqual([true]);
    expect(response).toMatchObject({ status: 401, decision: { dispatch: false, reason: "certificate_required" } });
  });

  it.each(["missing", "outage", "ambiguous", "cross-company", "cross-host", "wrong-issuer"])(
    "refuses %s protected trust", async (kind) => {
      const client = f.client();
      await client.post(path("request"));
      if (kind === "missing") f.setTrust(null);
      if (kind === "outage") f.failTrust();
      if (kind === "ambiguous") f.setTrust({ ...f.snapshot, registrations: [f.registration, f.registration] });
      if (kind === "cross-company") f.setTrust({ ...f.snapshot, registrations: [{ ...f.registration, companyId: randomUUID() }] });
      if (kind === "cross-host") f.setTrust({ ...f.snapshot, registrations: [f.registration,
        { ...f.registration, fingerprint: certificateFingerprint(new X509Certificate(material.replacement.cert)), hostId: "other-host", state: "retiring", overlapEndsAtMs: Date.now() + 10_000 }] });
      if (kind === "wrong-issuer") f.setTrust({ ...f.snapshot, registrations: [{ ...f.registration, issuerId: randomUUID() }] });
      expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
    });

  it.each(["uncertain", "rollback", "missing", "unavailable"])("refuses %s authority time", async (kind) => {
    const client = f.client();
    await client.post(path("request"));
    if (kind === "uncertain") await storage.db.update(publicationAuthorityClocks).set({ uncertain: true })
      .where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
    if (kind === "rollback") f.advance(-100);
    if (kind === "missing") await storage.db.delete(publicationAuthorityClocks)
      .where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
    if (kind === "unavailable") await storage.db.update(publicationAuthorityClocks).set({ clockEpoch: "lost-reference" })
      .where(eq(publicationAuthorityClocks.companyId, f.identity.companyId));
    expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
  });

  it("bounds renewal overlap and preserves broker, host, company, and single use", async () => {
    const end = (await f.clock()).wallMs + 500;
    f.setTrust({ registrations: [
      { ...f.registration, state: "retiring", overlapEndsAtMs: end },
      { ...f.registration, fingerprint: certificateFingerprint(new X509Certificate(material.replacement.cert)) },
    ], revokedIssuerIds: [] });
    const old = f.client(), replacement = f.client(material.replacement);
    expect((await old.post(path("request"))).decision.reason).toBe("recorded");
    expect((await replacement.post(path("request"))).decision.reason).toBe("replay");
    f.advance(501);
    expect((await old.post(path("dispatch"))).decision.dispatch).toBe(false);
    expect((await replacement.post(path("dispatch"))).decision.dispatch).toBe(true);
    expect((await replacement.post(path("dispatch"))).decision.dispatch).toBe(false);
  });

  it("requires an explicit overlap end and refuses two active certificates", async () => {
    const client = f.client();
    await client.post(path("request"));
    f.setTrust({ registrations: [{ ...f.registration, state: "retiring", overlapEndsAtMs: null }], revokedIssuerIds: [] });
    expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
    f.setTrust({ registrations: [f.registration,
      { ...f.registration, fingerprint: certificateFingerprint(new X509Certificate(material.replacement.cert)) }], revokedIssuerIds: [] });
    expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
  });

  it("disables both renewal certificates when the issuer is compromised", async () => {
    f.setTrust({ registrations: [
      { ...f.registration, state: "retiring", overlapEndsAtMs: Date.now() + 10_000 },
      { ...f.registration, fingerprint: certificateFingerprint(new X509Certificate(material.replacement.cert)) },
    ], revokedIssuerIds: [] });
    const old = f.client(), replacement = f.client(material.replacement);
    await old.post(path("request"));
    await replacement.post(path("request"));
    f.setTrust({ ...f.snapshot, revokedIssuerIds: [f.identity.issuerId] });
    expect((await old.post(path("dispatch"))).decision.dispatch).toBe(false);
    expect((await replacement.post(path("dispatch"))).decision.dispatch).toBe(false);
  });

  it("uses the earlier certificate or overlap expiry in the broker deadline", async () => {
    f.setTrust({ registrations: [{ ...f.registration, state: "retiring", overlapEndsAtMs: (await f.clock()).wallMs + 300 }], revokedIssuerIds: [] });
    const client = f.client();
    await client.post(path("request"));
    const { decision } = await client.post(path("dispatch"));
    expect(decision.dispatch).toBe(true);
    expect(decision.remainingLifetimeMs).toBe(300);
    expect(publicationDispatchWithinDeadline(decision, 100, 500)).toBe(false);
  });

  it("refuses a trust outage after initial certificate mapping", async () => {
    const client = f.client();
    await client.post(path("request"));
    f.beforeTrustRead((count) => { if (count === 2) f.failTrust(); });
    expect(await client.post(path("dispatch"))).toMatchObject({
      status: 503, decision: { dispatch: false, reason: "authority_unavailable" },
    });
  });

  it("counts trust read time toward the certificate deadline", async () => {
    const client = f.client();
    await client.post(path("request"));
    f.setTrust({ registrations: [{ ...f.registration, state: "retiring",
      overlapEndsAtMs: (await f.clock()).wallMs + 300 }], revokedIssuerIds: [] });
    f.beforeTrustRead((count) => { if (count === 2) f.advance(301); });
    expect((await client.post(path("dispatch"))).decision.dispatch).toBe(false);
  });

  function shortRunToken() {
    let wallMs = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => wallMs);
    const previousTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", "1");
    const token = createLocalAgentJwt(f.identity.agentId, f.identity.companyId, "codex_local", f.identity.runId)!;
    vi.stubEnv("PAPERCLIP_AGENT_JWT_TTL_SECONDS", previousTtl);
    return {
      headers: { Authorization: `Bearer ${token}` },
      expiresAtMs: (Math.floor(wallMs / 1_000) + 1) * 1_000,
      advance: (ms: number) => { wallMs += ms; f.advance(ms); },
    };
  }

  it.each(["at", "after"])("refuses run token expiry %s the locked trust read", async (when) => {
    const client = f.client();
    await client.post(path("request"));
    const run = shortRunToken();
    const elapsed = when === "at" ? run.expiresAtMs - Date.now() : 3_000;
    f.beforeTrustRead((count) => { if (count === 2) run.advance(elapsed); });
    expect(await client.post(path("dispatch"), f.bindings, run.headers)).toMatchObject({
      status: 200, decision: { dispatch: false, reason: "authority_unavailable" },
    });
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    expect(row.state).toBe("pending");
  });

  it("bounds the dispatch lifetime by run token expiry", async () => {
    const client = f.client();
    await client.post(path("request"));
    const run = shortRunToken();
    expect((await client.post(path("dispatch"), f.bindings, run.headers)).decision).toMatchObject({
      dispatch: true, remainingLifetimeMs: run.expiresAtMs - (await f.clock()).wallMs,
    });
  });

  it("refuses run token expiry during a request lock wait after the trust read", async () => {
    const client = f.client();
    await client.post(path("request"));
    const run = shortRunToken();
    const locked = barrier(), release = barrier();
    let pid = 0;
    const writer = storage.db.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      pid = row.pid;
      await tx.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId)).for("no key update");
      locked.release();
      await release.ready;
    });
    await locked.ready;
    const dispatch = client.post(path("dispatch"), f.bindings, run.headers);
    try {
      await waitForDatabaseWait(storage.db, pid);
      run.advance(3_000);
    } finally {
      release.release();
      await writer;
    }
    expect((await dispatch).decision.dispatch).toBe(false);
    const [row] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    expect(row.state).toBe("pending");
  });
});
