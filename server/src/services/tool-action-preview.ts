import type { AgentToolDescriptor } from "./plugin-tool-dispatcher.js";
import { summarizeToolValue } from "./tool-content-guards.js";

export type ToolGatewayProviderType =
  | "mcp_http_fixture"
  | "mcp_stdio_fixture"
  | "provider_rest"
  | "mcp_remote_http"
  | "mcp_local_stdio"
  | "paperclip_self"
  | "paperclip_plugin"
  | "paperclip_virtual"
  | "paperclip_github_chat"
  | "paperclip_slack_chat";

export interface ConnectedMcpGatewayMetadata {
  applicationId: string;
  applicationKey: string | null;
  applicationDisplayName: string;
  connectionId: string;
  catalogEntryId: string;
  transport: "mcp_remote" | "local_stdio" | "rest_api";
  gatewayToolName: string;
  upstreamToolName: string;
  catalogName: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown>;
  risk: {
    level: string;
    isReadOnly: boolean;
    isWrite: boolean;
    isDestructive: boolean;
  };
  onDemandTools?: boolean;
}

export interface ToolGatewayDescriptor extends AgentToolDescriptor {
  providerType: ToolGatewayProviderType;
  risk: "read" | "write" | "destructive";
  applicationId?: string | null;
  applicationKey?: string | null;
  applicationDisplayName?: string | null;
  connectionId?: string | null;
  catalogEntryId?: string | null;
  upstreamToolName?: string | null;
  providerMetadata?: ConnectedMcpGatewayMetadata | Record<string, unknown>;
}

export const REDACTED_ARGUMENT_SENTINEL = "***REDACTED***";

export function humanizeArgumentKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return key;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isIdentifierArgumentKey(key: string): boolean {
  return /(^|[_-])(id|ids|uuid|guid|key|token|hash|sha\d*)$/i.test(key);
}

export function humanizeArgumentValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === REDACTED_ARGUMENT_SENTINEL) return "hidden for privacy";
    return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

export function buildHumanizedActionPreview(input: {
  tool: ToolGatewayDescriptor;
  argumentsSummary: ReturnType<typeof summarizeToolValue>;
}): string {
  const actionName = input.tool.displayName?.trim() || input.tool.name;
  const trustLine =
    input.tool.risk === "destructive"
      ? `${actionName}. This can permanently change or remove data.`
      : actionName;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.argumentsSummary.summary);
  } catch {
    return trustLine;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return trustLine;

  const fieldLines: string[] = [];
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (fieldLines.length >= 6) break;
    if (isIdentifierArgumentKey(key)) continue;
    const rendered = humanizeArgumentValue(value);
    if (rendered === null) continue;
    fieldLines.push(`**${humanizeArgumentKey(key)}:** ${rendered}`);
  }

  if (fieldLines.length === 0) return trustLine;
  return [trustLine, ...fieldLines].join(" · ");
}
