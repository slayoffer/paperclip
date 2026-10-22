import type { toolPolicies } from "@paperclipai/db";
import type { ToolRateLimitRule } from "@paperclipai/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function rateLimitRule(policy: typeof toolPolicies.$inferSelect): ToolRateLimitRule | null {
  const config = isRecord(policy.config) ? policy.config : {};
  const raw = isRecord(config.rateLimit) ? config.rateLimit : config;
  const limit = typeof raw.limit === "number" ? raw.limit : null;
  const windowSeconds = typeof raw.windowSeconds === "number" ? raw.windowSeconds : null;
  if (!limit || !windowSeconds || limit <= 0 || windowSeconds <= 0) return null;
  return {
    limit: Math.floor(limit),
    windowSeconds: Math.floor(windowSeconds),
    keyBy: Array.isArray(raw.keyBy)
      ? raw.keyBy.filter((item): item is NonNullable<ToolRateLimitRule["keyBy"]>[number] => typeof item === "string")
      : undefined,
  };
}
