import type { SessionCompactionPolicy } from "@paperclipai/adapter-utils";

export function sessionCompactionReason(input: {
  policy: SessionCompactionPolicy;
  runs: number;
  inputTokens: number | null;
  ageHours: number;
}): string | null {
  const { policy, runs, inputTokens, ageHours } = input;
  if (policy.maxSessionRuns > 0 && runs > policy.maxSessionRuns) {
    return `session exceeded ${policy.maxSessionRuns} runs`;
  }
  if (policy.maxRawInputTokens > 0 && inputTokens !== null && inputTokens >= policy.maxRawInputTokens) {
    return `session raw input reached ${inputTokens.toLocaleString("en-US")} tokens ` +
      `(threshold ${policy.maxRawInputTokens.toLocaleString("en-US")})`;
  }
  if (policy.maxSessionAgeHours > 0 && ageHours >= policy.maxSessionAgeHours) {
    return `session age reached ${Math.floor(ageHours)} hours`;
  }
  return null;
}

export function buildSessionCompactionHandoff(input: {
  sessionId: string;
  issueId: string | null;
  reason: string;
  summary: string | null;
  continuationSummary?: string | null;
}): string {
  return [
    "Paperclip session handoff:",
    `- Previous session: ${input.sessionId}`,
    input.issueId ? `- Issue: ${input.issueId}` : "",
    `- Rotation reason: ${input.reason}`,
    input.summary ? `- Last run summary: ${input.summary}` : "",
    input.continuationSummary ? `- Issue continuation summary: ${input.continuationSummary.slice(0, 1_500)}` : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ].filter(Boolean).join("\n");
}
