import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  completionContracts,
  type createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";

export async function clearNativeQuestionFixtures(db: ReturnType<typeof createDb>) {
  // Delete fixture rows in dependency order. TRUNCATE CASCADE also reaches
  // publication_requests, whose history trigger rejects all truncation.
  // These tests create no publication records. Keep that protection active.
  await db.transaction(async (tx) => {
    await tx.delete(activityLog);
    await tx.update(heartbeatRuns).set({ wakeupRequestId: null });
    await tx.delete(agentWakeupRequests);
    await tx.delete(statusDecisionEffects);
    await tx.delete(nativeRunFinalizations);
    await tx.delete(statusDecisions);
    await tx.delete(workAssessments);
    await tx.delete(nativeRunResults);
    await tx.delete(issueThreadInteractions);
    await tx.delete(issueWorkProducts);
    await tx.delete(issueRelations);
    await tx.delete(issueComments);
    await tx.delete(heartbeatRunEvents);
    await tx.delete(heartbeatRuns);
    await tx.delete(completionContracts);
    await tx.delete(issues);
    await tx.delete(agents);
    await tx.delete(companyMemberships);
    await tx.delete(companies);
  });
}
