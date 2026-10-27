import type { Db } from "@paperclipai/db";
import { asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { readLatestUsageSample } from "./owner-sessions.js";

export type UsageTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

export function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(
      asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0)),
    ),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(
      asNumber(
        parsed.rawCachedInputTokens,
        asNumber(parsed.cachedInputTokens, 0),
      ),
    ),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(
      asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0)),
    ),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

export function deriveNormalizedUsageDelta(
  current: UsageTotals | null,
  previous: UsageTotals | null,
): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens =
    current.inputTokens >= previous.inputTokens
      ? current.inputTokens - previous.inputTokens
      : current.inputTokens;
  const cachedInputTokens =
    current.cachedInputTokens >= previous.cachedInputTokens
      ? current.cachedInputTokens - previous.cachedInputTokens
      : current.cachedInputTokens;
  const outputTokens =
    current.outputTokens >= previous.outputTokens
      ? current.outputTokens - previous.outputTokens
      : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

/** Ordinary and owner Codex sessions share the same cumulative counter contract. */
export async function resolveCumulativeSessionUsage(db: Db, input: {
  agentId: string; runId: string; sessionId: string; rawUsage: UsageTotals;
}) {
  const previousRawUsage = await readLatestUsageSample(db, {
    agentId: input.agentId, sessionId: input.sessionId, excludeRunId: input.runId,
  }, readRawUsageTotals);
  return {
    normalizedUsage: deriveNormalizedUsageDelta(input.rawUsage, previousRawUsage),
    previousRawUsage,
    derivedFromSessionTotals: previousRawUsage !== null,
  };
}
