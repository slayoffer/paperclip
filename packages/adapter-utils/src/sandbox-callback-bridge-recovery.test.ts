import { describe, expect, it } from "vitest";
import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
  HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST,
} from "./sandbox-callback-bridge.js";

describe.each([
  ["queue", DEFAULT_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST],
  ["http2", HTTP2_SANDBOX_CALLBACK_BRIDGE_ROUTE_ALLOWLIST],
] as const)("recovery routes over %s", (_transport, routes) => {
  it.each([
    ["GET", "/api/issues/issue-1/recovery-actions"],
    ["POST", "/api/issues/issue-1/recovery-actions/resolve"],
  ])("permits %s %s", (method, path) => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path }, routes)).toBeNull();
  });

  it.each([
    ["POST", "/api/issues/issue-1/recovery-actions"],
    ["PATCH", "/api/issues/issue-1/recovery-actions"],
    ["DELETE", "/api/issues/issue-1/recovery-actions"],
    ["GET", "/api/issues/issue-1/recovery-actions/resolve"],
    ["PATCH", "/api/issues/issue-1/recovery-actions/resolve"],
    ["DELETE", "/api/issues/issue-1/recovery-actions/resolve"],
    ["POST", "/api/issues/issue-1/recovery-actions/retry-workspace-export"],
    ["GET", "/api/issues/issue-1/recovery-actions/action-1"],
    ["POST", "/api/issues/issue-1/recovery-actions/resolve/extra"],
    ["POST", "/api/issues/issue-1/recovery-actions/resolve-extra"],
    ["POST", "/api/companies/company-1/recovery-actions/resolve"],
    ["POST", "/api/recovery-actions/resolve"],
  ])("denies %s %s", (method, path) => {
    expect(authorizeSandboxCallbackBridgeRequestWithRoutes({ method, path }, routes))
      .toBe(`Route not allowed: ${method} ${path}`);
  });
});
