export interface RunExecutionEvidenceReport {
  schema: "paperclip.execution-evidence/v1";
  runId: string;
  sourceInstanceId: string;
  complete: boolean;
  gaps: string[];
  phases: Array<{
    attemptId: string;
    phase: string;
    queuedAt: string | null;
    startedAt: string | null;
    endedAt: string | null;
    outcome: string;
    complete: boolean;
  }>;
  stops: Array<{
    requestId: string;
    requestedAt: string | null;
    source: string;
    reason: string;
    initiator: { type: string; id?: string } | null;
    result: string;
    intersectingAttempts: string[];
    terminalOutcome: string | null;
    complete: boolean;
  }>;
  phaseStopObserved: boolean;
  clock: { source: "controller_utc"; precisionMs: 1; offsetMs: null };
  terminationProof: false;
  collectedAt?: string;
}
