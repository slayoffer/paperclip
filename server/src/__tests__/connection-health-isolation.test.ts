import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, companySecretBindings, connectionGrants, createDb,
  heartbeatRuns, issues, toolApplications, toolCatalogEntries, toolConnections,
  toolPolicies, toolProfiles, toolProfileBindings,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { selectVaultConnectionGrant } from "../services/connection-vault-grant.js";
import { secretService } from "../services/secrets.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("connection health isolation", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-connection-health-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: "Health isolation", issuePrefix: `HI${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
    const [agent] = await db.insert(agents).values({
      companyId, name: "Reader", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Read app", status: "in_progress", assigneeAgentId: agent!.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, invocationSource: "assignment", status: "running",
      responsibleUserId: userId, contextSnapshot: { issueId: issue!.id },
    }).returning();
    const claims: RuntimeToolsTokenClaims = {
      sub: agent!.id, company_id: companyId, run_id: run!.id, responsible_user_id: userId,
      scope: "connection_intents", iat: 1, exp: 2, instance_id: "test",
    };
    const intents = connectionIntentService(db);
    const pending = await intents.request(claims, "notion");
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `health-${randomUUID()}`, name: "Notion", type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Health connection", uid: randomUUID(),
      transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active",
      enabled: true, healthStatus: "ok", healthCheckedAt: new Date(),
      config: { sourceTemplateKey: "notion", url: "https://8.8.8.8/mcp" },
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "organization", status: "active", isDefault: true,
    }).returning();
    await db.insert(toolCatalogEntries).values({
      companyId, applicationId: application!.id, connectionId: connection!.id,
      name: "read", toolName: "read", entryKind: "tool", riskLevel: "read", isReadOnly: true,
      status: "active", versionHash: "health-v1",
    });
    await db.insert(toolPolicies).values({
      companyId, name: "Allow reads", policyType: "allow", selectors: { riskLevel: "read" },
    });
    const [profile] = await db.insert(toolProfiles).values({
      companyId, name: "Reads", profileKey: "reads", defaultAction: "allow", status: "active",
    }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agent!.id });
    const complete = (canManageOrganizationGrant = true) => intents.complete(pending.interactionId!, connection!.id, userId, { canManageOrganizationGrant });
    const stored = () => db.select().from(toolConnections).where(eq(toolConnections.id, connection!.id)).then(rows => rows[0]!);
    async function execute(response: (id: string) => Response) {
      const gateway = createToolGatewayService(db, {
        toolActionSigningSecret: "health-isolation-test-signing",
        remoteHttpRequest: async (_url, init) => response(JSON.parse(String(init.body)).id),
      });
      const session = await gateway.createSession({ companyId, agentId: agent!.id, runId: run!.id });
      const tool = (await gateway.listToolsForSession(session.token)).find(item => item.providerType === "mcp_remote_http");
      expect(tool).toBeDefined();
      return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: {} });
    }
    return { companyId, userId, agent: agent!, connection: connection!, grant: grant!, complete, stored, execute };
  }

  it.each(["json", "sse", "content-length", "error-body"])("keeps health and intent completion after an oversized %s response", async (kind) => {
    const f = await fixture();
    await expect(f.execute(id => {
      const json = JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "x".repeat(1_000_001) }] } });
      return new Response(kind === "sse" ? `event: message\ndata: ${json}\n\n` : json, {
        status: kind === "error-body" ? 500 : 200,
        headers: { "content-type": kind === "sse" ? "text/event-stream" : "application/json",
          ...(kind === "content-length" ? { "content-length": "1000100" } : {}) },
      });
    })).rejects.toMatchObject({
      status: 502, reasonCode: "mcp_remote_response_too_large",
      details: { maxBytes: 1_000_000, hint: expect.stringContaining("Narrow") },
    });
    expect(await f.stored()).toMatchObject({ healthStatus: "ok", lastError: null });
    await expect(f.complete()).resolves.toMatchObject({ status: "accepted" });
  }, 30_000);

  it.each([400, 404, 409, 422, 429, 500, 503])("keeps a single HTTP %s failure local to the call", async status => {
    const f = await fixture();
    await expect(f.execute(() => new Response("request failed", { status })))
      .rejects.toMatchObject({ status: 502, reasonCode: "mcp_remote_status" });
    expect((await f.stored()).healthStatus).toBe("ok");
  });

  it.each([-32602, -32603, -32000])("keeps JSON-RPC request error %s local to the call", async code => {
    const f = await fixture();
    await expect(f.execute(id => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "request failed" } }))))
      .rejects.toMatchObject({ reasonCode: "remote_mcp_error" });
    expect((await f.stored()).healthStatus).toBe("ok");
  });

  it.each([401, 403])("marks HTTP %s authentication failures unhealthy", async status => {
    const f = await fixture();
    await expect(f.execute(() => new Response("unauthorized", { status }))).rejects.toMatchObject({ reasonCode: "mcp_remote_status" });
    expect((await f.stored()).healthStatus).toBe("error");
    await expect(f.complete()).rejects.toThrow("Finish and test");
  });

  // Upstream keeps a 2xx body that is not valid JSON-RPC local to the call and starts a fresh session.
  it.each(["invalid-json", "malformed"])("keeps %s response bodies local to the call", async kind => {
    const f = await fixture();
    await expect(f.execute(id => new Response(kind === "invalid-json" ? "not json" : JSON.stringify({ jsonrpc: "2.0", id }))))
      .rejects.toMatchObject({ status: 502 });
    expect((await f.stored()).healthStatus).toBe("ok");
  });

  it.each(["protocol", "transport"])("marks %s failures unhealthy", async kind => {
    const f = await fixture();
    await expect(f.execute(id => {
      if (kind === "transport") throw new TypeError("fetch failed");
      return new Response(kind === "invalid-json" ? "not json" : kind === "malformed" ? JSON.stringify({ jsonrpc: "2.0", id }) : JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } }));
    })).rejects.toMatchObject({ status: 502 });
    expect((await f.stored()).healthStatus).toBe("error");
  });

  it.each([["connection", true], ["grant", true], ["connection", false], ["grant", false]] as const)("tests rotated %s credentials before completion (healthy: %s)", async (location, healthy) => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const f = await fixture();
    const vault = secretService(db);
    const secret = await vault.create(f.companyId, { name: "Health token", provider: "local_encrypted", value: "old-test-value" });
    const refs = [{ secretId: secret.id, versionSelector: "latest" as const, configPath: "token" }];
    await db.insert(companySecretBindings).values({
      companyId: f.companyId, secretId: secret.id, targetType: "tool_connection", targetId: f.connection.id, configPath: "credentials.token",
    });
    await db.update(toolConnections).set({
      credentialPolicy: location === "grant" ? "per_user_with_fallback" : "shared",
      authKind: "api_key", healthStatus: "error", lastError: "oauth_refresh_missing",
      credentialRefs: [{ name: "token", placement: "header", key: "Authorization", prefix: "Bearer ", secretId: location === "grant" ? randomUUID() : secret.id, version: "latest" }],
      credentialSecretRefs: location === "connection" ? refs : [],
    }).where(eq(toolConnections.id, f.connection.id));
    await db.update(connectionGrants).set({ credentialSecretRefs: refs }).where(eq(connectionGrants.id, f.grant.id));
    await vault.rotate(secret.id, { value: "new-test-value" });
    expect(await f.stored()).toMatchObject({ healthStatus: "unchecked", healthCheckedAt: null, lastError: null });
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer new-test-value");
      const { id, method } = JSON.parse(String(init.body));
      expect(method).toBe("tools/list");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }), { status: healthy ? 200 : 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(f.complete(false)).rejects.toThrow("Sharing a company connection requires");
    expect(fetchMock).not.toHaveBeenCalled();
    if (healthy) {
      await expect(f.complete()).resolves.toMatchObject({ status: "accepted" });
      expect((await f.stored()).healthStatus).toBe("ok");
    } else {
      await expect(f.complete()).rejects.toMatchObject({ status: expect.any(Number) });
      expect((await f.stored()).healthStatus).toBe("error");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["dedicated", "organization-decoy", "retry"])("tests a rotated dedicated OAuth grant: %s", async (kind) => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const f = await fixture();
    const vault = secretService(db);
    const secret = await vault.create(f.companyId, { name: "Dedicated token", provider: "local_encrypted", value: "old-agent-value" });
    await db.insert(companySecretBindings).values({
      companyId: f.companyId, secretId: secret.id, targetType: "tool_connection", targetId: f.connection.id, configPath: "oauth.access_token",
    });
    await db.update(toolConnections).set({
      credentialPolicy: "per_agent", authKind: "oauth", credentialSource: "paperclip_vault", healthStatus: "error",
      credentialRefs: [{ name: "oauth.access_token", placement: "header", key: "Authorization", prefix: "Bearer ", secretId: randomUUID(), version: "latest" }],
    }).where(eq(toolConnections.id, f.connection.id));
    await db.update(connectionGrants).set({
      kind: "agent", subjectAgentId: f.agent.id, isDefault: false,
      credentialSecretRefs: [{ secretId: secret.id, versionSelector: "latest", configPath: "oauth.access_token" }],
    }).where(eq(connectionGrants.id, f.grant.id));
    if (kind !== "dedicated") await db.insert(connectionGrants).values({
      companyId: f.companyId, connectionId: f.connection.id, kind: "organization", status: "active", isDefault: true,
    });
    await vault.rotate(secret.id, { value: "new-agent-value" });
    expect((await f.stored()).healthStatus).toBe("unchecked");
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer new-agent-value");
      const { id, method } = JSON.parse(String(init.body));
      expect(method).toBe("tools/list");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } }), {
        status: kind === "retry" && fetchMock.mock.calls.length === 1 ? 401 : 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(f.complete(false)).resolves.toMatchObject({ status: "accepted" });
    expect((await f.stored()).healthStatus).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(kind === "retry" ? 2 : 1);
  });

  it.each(["foreign-agent", "inactive"])("refuses a %s dedicated grant before health testing", async (kind) => {
    const f = await fixture();
    await db.update(toolConnections).set({ credentialPolicy: "per_agent", healthStatus: "unchecked" })
      .where(eq(toolConnections.id, f.connection.id));
    const [foreign] = await db.insert(agents).values({ companyId: f.companyId, name: "Other agent", role: "engineer", adapterType: "process" }).returning();
    await db.update(connectionGrants).set({
      kind: "agent", subjectAgentId: kind === "foreign-agent" ? foreign!.id : f.agent.id,
      status: kind === "inactive" ? "revoked" : "active", isDefault: false,
    }).where(eq(connectionGrants.id, f.grant.id));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(f.complete()).rejects.toThrow("no usable identity grant");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await f.stored()).healthStatus).toBe("unchecked");
  });

  it.each(["company", "connection", "status"])("rechecks the selected grant %s without identity fallback", async (field) => {
    const f = await fixture();
    const foreign = await fixture();
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    let grantId = foreign.grant.id;
    if (field === "connection") {
      const [other] = await db.insert(toolConnections).values({
        ...f.connection, id: randomUUID(), uid: randomUUID(),
      }).returning();
      const [grant] = await db.insert(connectionGrants).values({
        companyId: f.companyId, connectionId: other!.id, kind: "organization", status: "active", isDefault: true,
      }).returning();
      grantId = grant!.id;
    } else if (field === "status") {
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id));
      grantId = f.grant.id;
    }
    await expect(selectVaultConnectionGrant(db, row!, {
      actorType: "user", actorId: f.userId, credentialGrantId: grantId,
    }, { setupUrl: "/setup", reconnectUrl: "/reconnect" })).rejects.toThrow("selected authorization is no longer active");
  });

  it("invalidates latest references and preserves pinned or foreign references", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    const f = await fixture();
    const foreign = await fixture();
    const vault = secretService(db);
    const secret = await vault.create(f.companyId, { name: "Selector token", provider: "local_encrypted", value: "old-test-value" });
    const header = { name: "token", placement: "header" as const, key: "Authorization", secretId: secret.id };
    const ref = { secretId: secret.id, configPath: "token" };
    await db.update(toolConnections).set({
      healthStatus: "error", credentialRefs: [{ ...header, version: 1 }],
      credentialSecretRefs: [{ ...ref, versionSelector: 1 }],
    }).where(eq(toolConnections.id, f.connection.id));
    await db.update(connectionGrants).set({ credentialSecretRefs: [{ ...ref, versionSelector: 1 }] })
      .where(eq(connectionGrants.id, f.grant.id));
    await db.update(toolConnections).set({ healthStatus: "error", credentialSecretRefs: [ref] })
      .where(eq(toolConnections.id, foreign.connection.id));
    const [latest] = await db.insert(toolConnections).values({
      ...f.connection, id: randomUUID(), uid: randomUUID(), credentialSecretRefs: [ref], healthStatus: "error",
    }).returning();
    await vault.rotate(secret.id, { value: "new-test-value" });
    expect((await f.stored()).healthStatus).toBe("error");
    expect((await foreign.stored()).healthStatus).toBe("error");
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, latest!.id)))[0]!.healthStatus).toBe("unchecked");
  });
});
