type FinalizationScope = { operationId: string; companyId: string; runId: string; issueId: string };
const activeFinalizations = new Map<string, FinalizationScope>();
const nativeFinalizations = new Map<string, FinalizationScope>();

function matches(active: FinalizationScope | undefined, scope: FinalizationScope) {
  return Boolean(active && active.companyId === scope.companyId && active.runId === scope.runId && active.issueId === scope.issueId);
}

export function isNativeWorkspaceFinalizationOperationActive(scope: FinalizationScope): boolean {
  return matches(nativeFinalizations.get(scope.operationId), scope);
}

export function isWorkspaceFinalizationOperationActive(scope: FinalizationScope): boolean {
  return matches(activeFinalizations.get(scope.operationId), scope);
}

/** A terminal run or recorder timeout cannot prove that its export callback stopped. */
export async function withWorkspaceFinalizationActivity<T>(input: {
  operationId: string; companyId: string; runId?: string | null; issueId?: string | null;
  phase: string; metadata?: Record<string, unknown> | null;
}, callback: () => Promise<T>): Promise<T> {
  if (input.phase !== "workspace_finalize" || !input.runId || !input.issueId) return callback();
  const scope = { operationId: input.operationId, companyId: input.companyId, runId: input.runId, issueId: input.issueId };
  activeFinalizations.set(input.operationId, scope);
  if (input.metadata?.owningService === "native_workspace_finalizer") nativeFinalizations.set(input.operationId, scope);
  try {
    return await callback();
  } finally {
    activeFinalizations.delete(input.operationId);
    nativeFinalizations.delete(input.operationId);
  }
}
