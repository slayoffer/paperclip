import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, companySecrets, connectionGrants, createDb, heartbeatRuns, issues,
  toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnections, toolPolicies,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("shared connection credential synchronization", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-reconnect-credentials-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(existingCompany?: typeof companies.$inferSelect) {
    const company = existingCompany ?? await db.insert(companies).values({
      name: "Credential synchronization", issuePrefix: `RC${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "Caller", role: "engineer", adapterType: "process",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: "Call a reconnected tool", status: "in_progress", assigneeAgentId: agent.id,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, invocationSource: "assignment",
      status: "running", contextSnapshot: { issueId: issue.id },
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id, applicationKey: randomUUID(), name: `Remote tools ${randomUUID()}`, type: "mcp_http", status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id, applicationId: application.id, name: `Remote tools ${randomUUID()}`, uid: randomUUID(),
      transport: "mcp_remote", credentialPolicy: "shared", status: "active", enabled: true,
      healthStatus: "ok", config: { url: "https://8.8.8.8/mcp" }, lastCatalogRefreshAt: new Date(),
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: company.id, connectionId: connection.id, kind: "organization", isDefault: true,
      status: "active", credentialSecretRefs: [],
    }).returning();
    await db.insert(toolCatalogEntries).values({
      companyId: company.id, applicationId: application.id, connectionId: connection.id,
      entryKind: "tool", name: "read_note", toolName: "read_note", riskLevel: "read", isReadOnly: true,
      status: "active", versionHash: randomUUID(), schemaHash: randomUUID(),
      inputSchema: { type: "object", properties: {} },
    });
    await db.insert(toolPolicies).values({
      companyId: company.id, name: `Allow reads ${randomUUID()}`, policyType: "allow", selectors: { riskLevel: "read" },
    });
    const calls: Array<{ method: string; authorization: string | null }> = [];
    const remoteHttpRequest = async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: body.method, authorization: new Headers(init.headers).get("authorization") });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : body.method === "tools/list"
          ? { tools: [{ name: "read_note", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: "text", text: "Read complete" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const access = toolAccessService(db, { remoteHttpRequest });
    const gateway = createToolGatewayService(db, { remoteHttpRequest, toolActionSigningSecret: "test-signing-secret" });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((entry) => entry.providerType === "mcp_remote_http")!;
    expect(tool).toBeDefined();
    return { company, connection, grant, access, gateway, session, tool, calls };
  }

  async function replaceCredential(context: Awaited<ReturnType<typeof fixture>>, operation: string) {
    const { company, connection, access } = context;
    if (operation === "reconnect") {
      await access.reconnectGalleryApp(connection.id, company.id, {
        credentialValues: { "credentials.authorization": "fixture-replacement" },
      }, { actorType: "user", actorId: "board" });
    } else {
      const secret = await secretService(db).create(company.id, {
        provider: "local_encrypted", key: `replacement.${randomUUID()}`,
        name: "Replacement", value: "fixture-replacement",
      });
      await access.updateConnection(connection.id, {
        credentialRefs: [{ name: "credentials.authorization", secretId: secret.id,
          version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
        ...(operation === "update" ? {
          credentialSecretRefs: [{ configPath: "credentials.authorization", secretId: secret.id, versionSelector: "latest" as const }],
        } : {}),
      });
    }
  }

  it.each(["reconnect", "update", "header-only update"])("%s adds a header that the next gateway call sends", async (operation) => {
    const context = await fixture();
    const unrelated = await fixture(context.company);
    const otherCompany = await fixture();
    const [personalGrant] = await db.insert(connectionGrants).values({
      companyId: context.company.id, connectionId: context.connection.id, kind: "user",
      subjectUserId: "another-user", status: "revoked", credentialSecretRefs: [],
    }).returning();
    await replaceCredential(context, operation);
    const updated = await context.access.getConnection(context.connection.id, context.company.id);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, context.grant.id));
    expect(grant.credentialSecretRefs).toEqual(updated.credentialSecretRefs);
    expect(grant.credentialSecretRefs).toHaveLength(1);
    for (const preserved of [unrelated.grant, otherCompany.grant, personalGrant]) {
      const [actual] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, preserved.id));
      expect(actual).toEqual(preserved);
    }
    context.calls.length = 0;
    await expect(context.gateway.executeTool({
      sessionToken: context.session.token, tool: context.tool.name, parameters: {},
    })).resolves.toMatchObject({ status: "completed" });
    expect(context.calls.filter((call) => call.method === "tools/call")).toEqual([
      { method: "tools/call", authorization: "Bearer fixture-replacement" },
    ]);
  });

  it("removes shared grant references when a header credential is removed", async () => {
    const context = await fixture();
    await replaceCredential(context, "header-only update");
    await context.access.updateConnection(context.connection.id, { credentialRefs: [] });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, context.grant.id));
    expect(grant.credentialSecretRefs).toEqual([]);
    expect((await context.access.getConnection(context.connection.id)).credentialSecretRefs).toEqual([]);
  });

  it("preserves revoked grants during a connection metadata update", async () => {
    const context = await fixture();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, context.grant.id));
    await context.access.updateConnection(context.connection.id, { name: "Renamed connection" });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, context.grant.id));
    expect(grant.status).toBe("revoked");
  });

  it("rejects a missing grant reference before any remote request and records health and audit", async () => {
    const context = await fixture();
    await db.update(toolConnections).set({ credentialRefs: [{
      name: "credentials.authorization", secretId: randomUUID(), version: "latest",
      placement: "header", key: "Authorization", prefix: "Bearer ",
    }] }).where(eq(toolConnections.id, context.connection.id));
    context.calls.length = 0;
    await expect(context.gateway.executeTool({
      sessionToken: context.session.token, tool: context.tool.name, parameters: {},
    })).rejects.toMatchObject({ status: 422, reasonCode: "mcp_remote_missing_secret" });
    expect(context.calls).toEqual([]);
    const updated = await context.access.getConnection(context.connection.id, context.company.id);
    expect(updated).toMatchObject({ healthStatus: "missing_secret", healthMessage: expect.stringContaining("selected grant") });
    const events = await db.select().from(toolAccessAuditEvents).where(and(
      eq(toolAccessAuditEvents.companyId, context.company.id),
      eq(toolAccessAuditEvents.action, "call_failed"),
    ));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "failure", reasonCode: "mcp_remote_missing_secret" });
    expect(events[0].details).toMatchObject({ reasonCode: "mcp_remote_missing_secret" });
    expect(JSON.stringify(events)).not.toContain("Bearer ");
  });

  it.each(["reconnect", "update"])("%s restores connection credentials when the grant update fails", async (operation) => {
    const context = await fixture();
    await db.execute(sql`CREATE FUNCTION reject_grant_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test grant update failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_grant_update BEFORE UPDATE ON connection_grants
      FOR EACH ROW EXECUTE FUNCTION reject_grant_update()`);
    try {
      await expect(replaceCredential(context, operation)).rejects.toMatchObject({
        cause: { message: "test grant update failure" },
      });
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, context.connection.id));
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, context.grant.id));
      expect(connection).toEqual(context.connection);
      expect(grant).toEqual(context.grant);
      if (operation === "reconnect") {
        expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, context.company.id))).toEqual([]);
      }
    } finally {
      await db.execute(sql`DROP TRIGGER reject_grant_update ON connection_grants`);
      await db.execute(sql`DROP FUNCTION reject_grant_update()`);
    }
  });
});
