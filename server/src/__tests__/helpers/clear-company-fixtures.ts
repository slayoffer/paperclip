import { retryFixtureCleanup } from "./truncate-with-deadlock-retry.js";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  costEvents,
  documents,
  issueRecoveryActions,
  heartbeatRunWatchdogDecisions,
  runIdentityContexts,
  environmentLeases,
  environments,
  companySkillVersions,
  issueTreeHolds,
  companySkills,
  projects,
  projectWorkspaces,
  goals,
  approvals,
  assets,
  connectionIntentDeliveries,
  toolApplications,
  toolConnections,
  toolConnectionInstalls,
  connectionGrants,
  toolCatalogEntries,
  toolProfiles,
  toolMcpGateways,
  toolProfileBindings,
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

export async function clearCompanyFixtures(db: ReturnType<typeof createDb>) {
  // Delete fixture rows in dependency order. TRUNCATE CASCADE also reaches
  // publication_requests, whose history trigger rejects all truncation.
  // These fixtures create no publication records. Keep that protection active.
  // Use this helper only with a disposable test database.
  await db.transaction(async (tx) => {
    await tx.delete(activityLog);
    await tx.delete(connectionIntentDeliveries);
    await tx.delete(toolProfileBindings);
    await tx.delete(toolMcpGateways);
    await tx.delete(toolProfiles);
    await tx.delete(connectionGrants);
    await tx.delete(toolCatalogEntries);
    await tx.delete(toolConnectionInstalls);
    await tx.delete(toolConnections);
    await tx.delete(toolApplications);
    await tx.delete(assets);
    await tx.delete(issueTreeHolds);
    await tx.delete(issueRecoveryActions);
    await tx.delete(heartbeatRunWatchdogDecisions);
    await tx.delete(environmentLeases);
    await tx.delete(environments);
    await tx.delete(runIdentityContexts);
    await tx.delete(costEvents);
    await tx.delete(agentTaskSessions);
    await tx.delete(agentRuntimeState);
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
    await tx.delete(documents);
    await tx.delete(projectWorkspaces);
    await tx.delete(projects);
    await tx.delete(goals);
    await tx.delete(approvals);
    await tx.delete(companySkillVersions);
    await tx.delete(companySkills);
    await tx.delete(agents);
    await tx.delete(companyMemberships);
    await tx.delete(companies);
  });
}

export async function clearCompanyFixturesWithDeadlockRetry(
  db: ReturnType<typeof createDb>,
  opts: { attempts?: number; delayMs?: (attempt: number) => number } = {},
): Promise<void> {
  await retryFixtureCleanup(() => clearCompanyFixtures(db), opts);
}
