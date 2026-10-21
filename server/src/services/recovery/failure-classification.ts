import { parseObject } from "../../adapters/utils.js";
import { parseProviderQuotaClockReset } from "./provider-quota-clock.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { DISPOSITION_REPAIR_MAX_ATTEMPTS } from "./disposition-repair.js";
import type { LatestIssueRun } from "./run-types.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const TRANSIENT_INFRA_CONTINUATION_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "timeout",
]);

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "native_provider_model_rejected",
  "provider_tool_definition_invalid",
  "adapter_engine_unavailable",
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
  // This is the fail-closed fallback for exceptions raised before an adapter
  // process starts. Known transient preflight failures use dedicated bounded
  // retry paths instead of generic issue continuation recovery.
  "setup_failed",
  // Setup owns the shared durable retry budget for temporary Git scans.
  // Generic continuation must not retry permanent failures or reset that budget.
  "workspace_git_scan_timeout",
  "workspace_git_scan_saturated",
  "workspace_git_scan_cancelled",
  "workspace_git_scan_output_limit",
  "workspace_git_scan_failed",
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
]);

// A continuation cancelled with this code is a *deliberate wait* (the latest run
// reported it was parked for review/approval), not a lost execution path. When the
// issue has a real waiting target we convert it into a normal dependency wait rather
// than escalating it as stranded.
export const CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE =
  "issue_continuation_waiting_on_review";

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
export const PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your (?:\w+ )?limit|usage limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;
const CONFIGURATION_INCOMPLETE_ERROR_RE =
  /(?:model_not_found|model [^\n]{0,120} not found|missing (?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|no (?:api )?(?:key|credentials?) (?:was |were )?(?:found|configured|provided)|api key (?:is )?(?:not set|unavailable))/i;

export type AdapterFailureRecoveryClassification =
  | { kind: "provider_quota"; retryAt: Date; parsedResetTime: boolean }
  | { kind: "configuration_incomplete" }
  | null;

export function classifyAdapterFailureForRecovery(
  latestRun: Pick<
    NonNullable<LatestIssueRun>,
    "error" | "errorCode" | "resultJson"
  >,
  now = new Date(),
): AdapterFailureRecoveryClassification {
  // An engine prerequisite cannot be repaired by asking the same unavailable
  // engine to retry. Use the existing configuration-blocker path.
  if (latestRun.errorCode === "adapter_engine_unavailable" || latestRun.errorCode === "provider_tool_definition_invalid" || latestRun.errorCode === "native_provider_model_rejected") {
    return { kind: "configuration_incomplete" };
  }
  if (
    latestRun.errorCode !== "adapter_failed" &&
    latestRun.errorCode !== "provider_quota" &&
    latestRun.errorCode !== "configuration_incomplete"
  ) {
    return null;
  }
  const resultJson = parseObject(latestRun.resultJson);
  const error = [
    latestRun.errorCode ?? "",
    latestRun.error ?? "",
    JSON.stringify(resultJson),
  ].join("\n");
  if (
    latestRun.errorCode === "configuration_incomplete" ||
    CONFIGURATION_INCOMPLETE_ERROR_RE.test(error)
  ) {
    return { kind: "configuration_incomplete" };
  }
  if (
    latestRun.errorCode !== "provider_quota" &&
    !PROVIDER_QUOTA_ERROR_RE.test(error)
  )
    return null;

  const persistedRetryAt =
    readNonEmptyString(resultJson.retryNotBefore) ??
    readNonEmptyString(resultJson.transientRetryNotBefore) ??
    readNonEmptyString(resultJson.providerQuotaRetryNotBefore);
  const parsedPersistedRetryAt = persistedRetryAt
    ? new Date(persistedRetryAt)
    : null;
  if (
    parsedPersistedRetryAt &&
    !Number.isNaN(parsedPersistedRetryAt.getTime()) &&
    parsedPersistedRetryAt > now
  ) {
    return {
      kind: "provider_quota",
      retryAt: parsedPersistedRetryAt,
      parsedResetTime: true,
    };
  }

  const parsedClockReset = parseProviderQuotaClockReset(error, now);
  if (parsedClockReset) {
    return {
      kind: "provider_quota",
      retryAt: parsedClockReset,
      parsedResetTime: true,
    };
  }
  return {
    kind: "provider_quota",
    retryAt: new Date(
      now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
    ),
    parsedResetTime: false,
  };
}

type ContinuationRetryClassification = {
  kind:
    | "transient_infra"
    | "non_retryable"
    | "deliberate_wait_without_target"
    | "default";
  maxAttempts: number;
  baseBackoffMs: number;
  errorCode: string | null;
};

export function classifyContinuationFailure(
  latestRun: LatestIssueRun,
): ContinuationRetryClassification {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
    return {
      kind: "deliberate_wait_without_target",
      maxAttempts: DISPOSITION_REPAIR_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  if (isAiAuthenticationBlocked(latestRun) || (errorCode && NON_RETRYABLE_CONTINUATION_ERROR_CODES.has(errorCode))) {
    return {
      kind: "non_retryable",
      maxAttempts: 0,
      baseBackoffMs: 0,
      errorCode,
    };
  }
  if (errorCode && TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return {
      kind: "transient_infra",
      maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  return {
    kind: "default",
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: 0,
    errorCode,
  };
}
