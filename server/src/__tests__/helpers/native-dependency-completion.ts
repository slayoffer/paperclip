import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { completionContracts, heartbeatRuns, issues, issueWorkProducts, type Db } from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_OPEN,
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../../vendor/paperclip-runner/testing.js";
import { PaperclipControlPlanePort } from "../../services/native-runtime/paperclip-control-plane-port.js";

export async function seedNativeDependencyCompletion(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
}) {
  const runId = randomUUID();
  const contractId = randomUUID();
  const sessionId = randomUUID();
  const runnerInstanceId = randomUUID();
  const contractSha = `dependency-contract-${runId}`;
  await db.insert(completionContracts).values({
    id: contractId, companyId: input.companyId, issueId: input.issueId, revision: 1,
    schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1",
    risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: { revision: "phase6-v1", objective: "Complete blocker", criteria: [{ id: "objective", requirement: "Complete blocker" }] },
    canonicalSha256: contractSha, createdByActorType: "system", createdByActorId: "test",
  });
  await db.insert(heartbeatRuns).values({
    id: runId, companyId: input.companyId, agentId: input.agentId, status: "running", runtimeMode: "native",
    nativeIssueId: input.issueId, nativeSessionId: sessionId, runnerInstanceId,
    completionContractId: contractId, completionContractSha256: contractSha, contextSnapshot: { issueId: input.issueId },
  });
  await db.update(issues).set({ assigneeAgentId: input.agentId }).where(eq(issues.id, input.issueId));
  const workProductId = randomUUID();
  await db.insert(issueWorkProducts).values({
    id: workProductId, companyId: input.companyId, issueId: input.issueId, type: "artifact", provider: "paperclip",
    title: "Verified blocker result", status: "ready_for_review", reviewState: "approved", createdByRunId: runId,
  });
  const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
  const evidenceRef = `work_product:${workProductId}`;
  result.completionClaim.contractRevision = "phase6-v1";
  result.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
  result.evidence = [{ kind: "work_product", ref: evidenceRef }];
  result.verification[0]!.artifactRef = evidenceRef;
  const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, ...input, runId, sessionId };
  const port = new PaperclipControlPlanePort(db, {
    ...input, runId, sessionId, completionContractId: contractId, completionContractSha256: contractSha,
    sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: `dependency-control-${runId}`,
  });
  await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerInstanceId });
  await port.completeRun({
    result,
    terminal: structuredClone(CONTROL_PLANE_CONFORMANCE_TERMINAL),
    callerResultId: `dependency-result-${runId}`,
  });
  return runId;
}
