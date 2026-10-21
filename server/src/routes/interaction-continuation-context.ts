import { HttpError } from "../errors.js";
export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readToolActionExecutionStatus(value: unknown) {
  return value === "approved" ||
    value === "executing" ||
    value === "executed" ||
    value === "failed" ||
    value === "expired"
    ? value
    : null;
}

export function readToolActionContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const toolActionPayload = readObject(payload.toolAction);
  const toolName = readNonEmptyString(toolActionPayload.toolName);
  const actionRequestId = readNonEmptyString(toolActionPayload.actionRequestId);
  if (!toolName || !actionRequestId) return null;

  const result = readObject(interaction.result);
  const toolActionResult = readObject(result.toolAction);
  const declineReason =
    interaction.status === "rejected"
      ? readNonEmptyString(result.reason)
      : null;
  const error = readNonEmptyString(toolActionResult.errorMessage);
  const resultSummary = readNonEmptyString(toolActionResult.resultSummary);

  if (interaction.status === "rejected") {
    return {
      toolName,
      actionRequestId,
      decision: "rejected",
      executionStatus: "rejected",
      ...(declineReason ? { declineReason } : {}),
      instructions: `the action was declined${declineReason ? `: ${declineReason}` : ""}; do not retry the same call — adjust your approach or mark the task blocked/in_review with the decline reason.`,
    };
  }

  if (interaction.status !== "accepted") return null;
  const executionStatus = readToolActionExecutionStatus(
    toolActionResult.status,
  );
  if (!executionStatus) return null;

  if (executionStatus === "executed") {
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(resultSummary ? { resultSummary } : {}),
      instructions: `the approved ${toolName} action already ran — do not call the tool again; continue with this result.`,
    };
  }

  if (executionStatus === "failed") {
    const failureMessage = error ?? "an unknown error";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved action ran and failed with ${failureMessage}; adjust your approach — a fresh call will open a new approval.`,
    };
  }

  if (executionStatus === "expired") {
    const expirationMessage = error ? `: ${error}` : "";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved ${toolName} action expired before execution${expirationMessage}; if the task still requires it, call the tool again to request a fresh approval.`,
    };
  }

  return {
    toolName,
    actionRequestId,
    decision: "accepted",
    executionStatus,
    instructions: `the approved ${toolName} action is ${executionStatus}; do not call the tool again while this approval is being processed.`,
  };
}

export function readSecretProposalContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const proposal = readObject(payload.secretProposal);
  const proposalId = readNonEmptyString(proposal.proposalId);
  const configPath = readNonEmptyString(proposal.configPath);
  if (!proposalId || !configPath) return null;
  const result = readObject(interaction.result);
  const execution = readObject(result.secretProposal);
  const executionStatus = readNonEmptyString(execution.status);
  const errorCode = readNonEmptyString(execution.errorCode);
  const sourceSecretLabel = readNonEmptyString(proposal.sourceSecretLabel);

  if (interaction.status === "rejected") {
    return {
      proposalId,
      configPath,
      decision: "rejected",
      executionStatus: "rejected",
      instructions:
        "the secret binding proposal was rejected; do not assume the alias exists.",
    };
  }
  if (
    interaction.status !== "accepted" ||
    (executionStatus !== "executed" && executionStatus !== "failed")
  ) {
    return null;
  }
  if (executionStatus === "executed") {
    return {
      proposalId,
      configPath,
      decision: "accepted",
      executionStatus,
      ...(sourceSecretLabel ? { sourceSecretLabel } : {}),
      instructions: `the binding was created at ${configPath}; verify it with GET /api/agents/me/secrets before using it.`,
    };
  }
  return {
    proposalId,
    configPath,
    decision: "accepted",
    executionStatus,
    ...(errorCode ? { errorCode } : {}),
    instructions:
      "the binding was not created; inspect the failure comment and submit a fresh proposal after fixing the cause.",
  };
}

export function secretProposalExecutionErrorCode(error: unknown) {
  if (error instanceof HttpError) {
    const details = readObject(error.details);
    return readNonEmptyString(details.code) ?? `http_${error.status}`;
  }
  return "secret_proposal_execution_failed";
}
