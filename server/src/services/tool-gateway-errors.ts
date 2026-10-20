export class ToolGatewayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reasonCode: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const MAX_REMOTE_MCP_RESPONSE_BYTES = 1_000_000;

export function responseTooLargeError() {
  return new ToolGatewayHttpError(
    502,
    "Remote MCP response exceeded the gateway size limit",
    "mcp_remote_response_too_large",
    { maxBytes: MAX_REMOTE_MCP_RESPONSE_BYTES, hint: "Narrow the query or request fewer results." },
  );
}

export async function readBoundedRemoteResponse(
  response: Response,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number(contentLength) > MAX_REMOTE_MCP_RESPONSE_BYTES
  ) {
    throw responseTooLargeError();
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_REMOTE_MCP_RESPONSE_BYTES) {
    throw responseTooLargeError();
  }
  return body;
}

export function malformedRemoteMcpResponse(): ToolGatewayHttpError {
  return new ToolGatewayHttpError(
    502,
    "Remote MCP server returned a malformed tools/call response",
    "remote_mcp_malformed_response",
  );
}
