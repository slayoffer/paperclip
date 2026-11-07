import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PaperclipApiClient } from "./client.js";
import { createPaperclipMcpServer } from "./index.js";
import { createToolDefinitions } from "./tools.js";

const apiKey = "test-api-credential";
const runtimeToken = "test-runtime-credential";
const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey,
  companyId: null,
  agentId: null,
  runId: null,
};

function getTool(name: string) {
  const client = new PaperclipApiClient(config);
  return createToolDefinitions(client).find((tool) => tool.name === name)!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const toolCases: Array<[string, Record<string, unknown>]> = [
  ["paperclipMe", {}],
  ["paperclipApiRequest", { method: "GET", path: "/missing" }],
  ["connections_search", { query: "test" }],
  ["connection_request", {
    service: "test",
    connectionId: "11111111-1111-4111-8111-111111111111",
  }],
];

describe.each(toolCases)("%s HTTP results", (name, input) => {
  function prepareResponse(body: string, status: number) {
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL", "http://localhost/runtime/search");
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL", "http://localhost/runtime/request");
    vi.stubEnv("PAPERCLIP_RUNTIME_TOOLS_TOKEN", runtimeToken);
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status,
      headers: { Authorization: "Bearer response-header-value" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it.each<[number, string, string]>([
    [502, "<html><title>502 Bad Gateway</title><body>nginx</body></html>", "Bad Gateway"],
    [404, "Not Found", "Not Found"],
    [409, JSON.stringify({ error: "Issue checkout conflict", details: { retry: false } }), "checkout conflict"],
  ])("marks HTTP %s as a tool error", async (status, body, excerpt) => {
    const fetchMock = prepareResponse(body, status);
    const result = await getTool(name).execute(input);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0]!.text);
    expect(error.status).toBe(status);
    expect(error.error).toContain(`HTTP ${status}`);
    expect(error.body).toContain(excerpt);
    expect(error.body.length).toBeLessThanOrEqual(512);
    expect(result.content[0]!.text).not.toContain(apiKey);
    expect(result.content[0]!.text).not.toContain(runtimeToken);
    expect(result.content[0]!.text).not.toContain("response-header-value");
    expect(error).not.toHaveProperty("headers");
  });

  it("preserves the HTTP 200 result", async () => {
    const body = { ok: true, items: [{ id: "item-1" }] };
    const fetchMock = prepareResponse(JSON.stringify(body), 200);
    const result = await getTool(name).execute(input);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    });
  });
});

describe("API error excerpts", () => {
  it.each([
    '<input name="api_key" value="private-value">Bad Gateway',
    '<input value="ignore>private-value" name="api_key">Bad Gateway',
    '<script>const value = "private-value";</script>Bad Gateway',
    '<!-- private-value -->Bad Gateway',
    'Bad Gateway<input name="api_key" value="private-value',
  ])("removes HTML attributes and hidden content: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 502 })));
    const result = await getTool("paperclipMe").execute({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).body).toBe("Bad Gateway");
    expect(result.content[0]!.text).not.toContain("private-value");
  });

  it.each(["", "null"])("preserves the actual error body %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 500 })));
    const result = await getTool("paperclipMe").execute({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).body).toBe(body);
  });

  it("sends the error flag through the MCP protocol", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
    ));
    const { server } = createPaperclipMcpServer(config);
    const client = new Client({ name: "error-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "paperclipMe", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{
        type: "text", text: expect.stringContaining("HTTP 502"),
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retains the HTTP status when the response body cannot be read", async () => {
    const response = new Response(null, { status: 502 });
    vi.spyOn(response, "text").mockRejectedValue(new Error(`read failed: ${apiKey}`));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await getTool("paperclipMe").execute({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).status).toBe(502);
    expect(result.content[0]!.text).not.toContain(apiKey);
    expect(result.content[0]!.text).toContain("[body unavailable]");
  });

  it("masks credential fields in malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      '{"access_token":"private-value","password":"other-value",', { status: 502 },
    )));
    const result = await getTool("paperclipMe").execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("private-value");
    expect(result.content[0]!.text).not.toContain("other-value");
  });

  it("redacts JSON credentials and query values before formatting", async () => {
    const body = {
      error: `Conflict for Bearer ${apiKey}`,
      credentials: { apiKey: "nested-value" },
      details: [{ access_token: "response-token", password: "response-password" }],
      note: `Do not repeat ${apiKey}`,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 409 }),
    ));

    const result = await getTool("paperclipApiRequest").execute({
      method: "GET", path: "/issues?token=query-value",
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    for (const value of [apiKey, "nested-value", "response-token", "response-password", "query-value"]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain("[REDACTED]");
    expect(JSON.parse(text).path).toBe("/issues");
  });

  it("redacts text credentials before it truncates a long HTML error", async () => {
    const body = `<html>Bad Gateway ${apiKey} Bearer other-value token=body-value ${"x".repeat(900)}</html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 502 })));

    const result = await getTool("paperclipMe").execute({});
    const error = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBe(true);
    expect(error.body.length).toBe(512);
    expect(error.body).toContain("Bad Gateway");
    expect(error.body).toContain("[REDACTED]");
    expect(error.body).toMatch(/\.\.\.$/);
    expect(result.content[0]!.text).not.toContain(apiKey);
    expect(result.content[0]!.text).not.toContain("other-value");
    expect(result.content[0]!.text).not.toContain("body-value");
  });

  it.each(["/api/issues", "/api/", "/api", "/api?token=hidden"])(
    "explains the repeated prefix in %s before fetch",
    async (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const result = await getTool("paperclipApiRequest").execute({ method: "GET", path });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("The server adds /api.");
      expect(result.content[0]!.text).toContain("Remove the prefix");
      expect(result.content[0]!.text).not.toContain("hidden");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a successful plain-text response unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ready", { status: 200 })));
    expect(await getTool("paperclipMe").execute({})).toEqual({
      content: [{ type: "text", text: "ready" }],
    });
  });

  it("keeps a successful empty response unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await getTool("paperclipMe").execute({})).toEqual({
      content: [{ type: "text", text: "null" }],
    });
  });
});
