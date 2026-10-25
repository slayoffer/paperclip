import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, toolProfileBindings, toolProfiles } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { forgetMcpHttpSessions, MCP_PROTOCOL_VERSION } from "../services/mcp-http.js";
import { createRemoteMcpTool } from "./helpers/tool-gateway-remote-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("remote MCP connection timeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-mcp-timeout-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it.each([
    { name: "25-second connection budget permits a 15-second call", configured: 25_000, callMs: 15_000, succeeds: true },
    { name: "default budget expires at 10 seconds", configured: undefined, callMs: 10_000, succeeds: false },
    { name: "default budget permits a call before 10 seconds", configured: undefined, callMs: 9_999, succeeds: true },
    { name: "session setup does not consume the call budget", configured: undefined, setupMs: 4_000, callMs: 9_000, succeeds: true },
    { name: "session setup has its own 10-second limit", configured: 25_000, setupMs: 6_000, callMs: 1, succeeds: false },
    { name: "explicit request budget overrides the connection", configured: 25_000, explicit: 100, callMs: 100, succeeds: false },
    { name: "connection budget clamps to 60 seconds", configured: 90_000, callMs: 60_000, succeeds: false },
    { name: "connection budget clamps to one millisecond", configured: -1, callMs: 1, succeeds: false },
    { name: "connection budget rounds down", configured: 10.9, callMs: 10, succeeds: false },
    { name: "invalid connection budget uses the default", configured: "25000", callMs: 10_000, succeeds: false },
  ])("$name", async (scenario) => {
    const [company] = await db.insert(companies).values({
      name: "Timeout test", issuePrefix: randomUUID(),
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "Timeout agent", role: "engineer", adapterType: "process",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, status: "running",
      invocationSource: "on_demand", triggerDetail: "manual",
    }).returning();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: company.id, profileKey: "all", name: "All tools", defaultAction: "allow",
    }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const remote = await createRemoteMcpTool(db, company.id, {
      riskLevel: "read",
      connectionConfig: { toolTimeoutMs: scenario.configured, mcpSessionRequired: !!scenario.setupMs },
    });
    const methods: string[] = [];
    let callSignal: AbortSignal | null | undefined;
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "timeout-test-signing-secret",
      remoteHttpRequest: async (_url, init) => {
        const request = JSON.parse(String(init.body));
        methods.push(request.method);
        await vi.advanceTimersByTimeAsync(request.method === "tools/call" ? scenario.callMs : scenario.setupMs ?? 0);
        if (init.signal?.aborted) throw new DOMException("Timed out", "AbortError");
        if (request.method === "tools/call") callSignal = init.signal;
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0", id: request.id,
          result: request.method === "initialize"
            ? { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "timeout", version: "1" } }
            : { content: [{ type: "text", text: "ok" }] },
        }, { headers: { "mcp-session-id": remote.connection.id } });
      },
    });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find((item) => item.connectionId === remote.connection.id)!;
    expect(tool).toBeTruthy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const execution = gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { key: "a", value: "b" }, timeoutMs: scenario.explicit });
      if (scenario.succeeds) {
        await expect(execution).resolves.toMatchObject({ status: "completed", result: { content: "ok" } });
        // Successful calls must release their deadline timer.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(callSignal?.aborted).toBe(false);
      } else {
        await expect(execution).rejects.toMatchObject({ status: 504, reasonCode: "tool_timeout" });
      }
      if (scenario.setupMs === 4_000) expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    } finally {
      vi.useRealTimers();
      forgetMcpHttpSessions(remote.connection.id);
    }
  });
});
