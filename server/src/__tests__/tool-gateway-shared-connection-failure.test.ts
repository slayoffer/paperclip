import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, toolConnectionInstalls,
  toolConnections, toolMcpGateways, toolProfileBindings, toolProfileEntries,
  toolProfiles, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { createRemoteMcpTool } from "./helpers/tool-gateway-remote-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("shared remote connection failure discovery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const originalApiUrl = process.env.PAPERCLIP_API_URL;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-shared-failure-");
    db = createDb(temp.connectionString);
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
  }, 20_000);

  afterAll(async () => {
    if (originalApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrl;
    await temp?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: `Shared failure ${randomUUID()}`,
      issuePrefix: `SF${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const remote = await createRemoteMcpTool(db, company!.id, {
      url: "https://8.8.8.8/mcp", toolName: "read", riskLevel: "read",
    });
    await db.update(toolConnections).set({ credentialPolicy: "shared" })
      .where(eq(toolConnections.id, remote.connection.id));
    const assigned = await db.insert(agents).values(["first", "second"].map(name => ({
      companyId: company!.id, name, role: "engineer", adapterType: "codex_local", adapterConfig: {},
    }))).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company!.id, profileKey: `shared-${randomUUID()}`, name: "Shared read", defaultAction: "deny",
    }).returning();
    await db.insert(toolProfileEntries).values({
      companyId: company!.id, profileId: profile!.id, selectorType: "connection", effect: "include",
      connectionId: remote.connection.id,
    });
    await db.insert(toolProfileBindings).values(assigned.map(agent => ({
      companyId: company!.id, profileId: profile!.id, targetType: "agent" as const, targetId: agent.id,
    })));
    await db.insert(toolConnectionInstalls).values({
      companyId: company!.id, connectionId: remote.connection.id, targetType: "company", targetId: company!.id,
    });
    async function newRun(agent: typeof assigned[number]) {
      return db.insert(heartbeatRuns).values({
        companyId: company!.id, agentId: agent.id, status: "running", contextSnapshot: {},
      }).returning().then(rows => rows[0]!);
    }
    const stored = () => db.select().from(toolConnections)
      .where(eq(toolConnections.id, remote.connection.id)).then(rows => rows[0]!);
    return { company: company!, remote, first: assigned[0]!, second: assigned[1]!, newRun, stored };
  }

  it.each([
    { kind: "fetch", status: 502, code: "mcp_remote_fetch_failed" },
    { kind: "timeout", status: 504, code: "tool_timeout" },
  ])("preserves discovery and recovery after a $kind failure", async ({ kind, status, code }) => {
    const f = await fixture();
    let fail = true;
    const gateway = createToolGatewayService(db, {
      remoteHttpRequest: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.method === "tools/call" && fail) {
          const error = new Error("Fixture upstream failure");
          if (kind === "timeout") error.name = "AbortError";
          throw error;
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
          result: body.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
            : { content: [{ type: "text", text: "Recovered" }] },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    const run = await f.newRun(f.first);
    const session = await gateway.createSession({ companyId: f.company.id, agentId: f.first.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token))
      .find(entry => entry.connectionId === f.remote.connection.id)!;
    expect(tool).toBeDefined();
    const call = () => gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { key: "test", value: "test" } });
    await expect(call()).rejects.toMatchObject({ status, reasonCode: code });
    expect(await f.stored()).toMatchObject({ healthStatus: "error" });

    // A separate service instance must read the changed shared health.
    const reader = createToolGatewayService(db);
    const otherRun = await f.newRun(f.second);
    const otherSession = await reader.createSession({ companyId: f.company.id, agentId: f.second.id, runId: otherRun.id });
    expect(await reader.listToolsForSession(otherSession.token))
      .toContainEqual(expect.objectContaining({ catalogEntryId: f.remote.catalogEntry.id }));
    const servers = await buildPaperclipRuntimeMcpServers({ db, agent: f.second, runId: otherRun.id });
    expect(servers).toHaveLength(1);
    const [runtimeGateway] = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.agentId, f.second.id));
    expect(await reader.listToolsForNamedGateway({ gatewayId: runtimeGateway!.id, bearerToken: servers[0]!.token }))
      .toContainEqual(expect.objectContaining({ catalogEntryId: f.remote.catalogEntry.id }));

    // Another explicit call must return the upstream error, not tool_not_found.
    await expect(call()).rejects.toMatchObject({ status, reasonCode: code });
    fail = false;
    await call();
    expect(await f.stored()).toMatchObject({ healthStatus: "ok" });
  });

  it.each([
    { healthStatus: "missing_secret" as const },
    { healthStatus: "degraded" as const },
    { healthStatus: "error" as const, enabled: false },
    { healthStatus: "error" as const, status: "disabled" as const },
  ])("does not deliver a connection with $healthStatus and $status or $enabled", async state => {
    const f = await fixture();
    await db.update(toolConnections).set(state).where(eq(toolConnections.id, f.remote.connection.id));
    const run = await f.newRun(f.second);
    const gateway = createToolGatewayService(db);
    const session = await gateway.createSession({ companyId: f.company.id, agentId: f.second.id, runId: run.id });
    expect((await gateway.listToolsForSession(session.token)).some(tool => tool.connectionId === f.remote.connection.id)).toBe(false);
    expect(await buildPaperclipRuntimeMcpServers({ db, agent: f.second, runId: run.id })).toEqual([]);
  });
});
