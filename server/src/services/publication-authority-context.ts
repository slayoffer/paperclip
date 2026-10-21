import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agents, companies, heartbeatRuns, issues, projectWorkspaces,
  publicationAuthorityClocks, publicationBrokers,
  type Db,
} from "@paperclipai/db";
import type { PublicationBindings, PublicationIdentity } from "@paperclipai/shared";

export type PublicationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface AuthorityTime { wallMs: number; monotonicMs: number; epoch: string }
export type AuthorityClock = (tx: PublicationTransaction) => Promise<AuthorityTime | null>;
// A process restart loses the clock reference. Protected registration must establish a fresh epoch.
const processClockEpoch = randomUUID();

export const databaseAuthorityClock: AuthorityClock = async (tx) => {
  const [row] = await tx.execute<{ now: string }>(sql`select floor(extract(epoch from clock_timestamp()) * 1000)::text as now`);
  return row ? { wallMs: Number(row.now), monotonicMs: Number(process.hrtime.bigint() / 1_000_000n), epoch: processClockEpoch } : null;
};

// Row locks conflict with every ordinary UPDATE and DELETE, including direct SQL writers.
// Lock order: issue, run, agent, company, workspace, clock, broker, request.
export async function lockPublicationContext(tx: PublicationTransaction, b: PublicationBindings, identity: PublicationIdentity) {
  if (["companyId", "brokerId", "agentId", "runId"].some((key) =>
    b[key as keyof PublicationBindings] !== identity[key as keyof PublicationIdentity])) return "identity_mismatch";

  const [issue] = await tx.select().from(issues)
    .where(and(eq(issues.companyId, identity.companyId), eq(issues.id, b.issueId))).for("no key update");
  if (!issue) return "issue_unavailable";
  const [run] = await tx.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, identity.companyId), eq(heartbeatRuns.id, identity.runId))).for("no key update");
  const [agent] = await tx.select().from(agents)
    .where(and(eq(agents.companyId, identity.companyId), eq(agents.id, identity.agentId))).for("no key update");
  const [company] = await tx.select().from(companies).where(eq(companies.id, identity.companyId)).for("no key update");
  if (!run || run.agentId !== identity.agentId || run.status !== "running"
    || (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issue.id) return "run_unavailable";
  if (!agent || !["active", "idle", "running"].includes(agent.status) || company?.status !== "active") return "principal_unavailable";
  if (issue.assigneeAgentId !== identity.agentId || issue.assigneeUserId !== null
    || issue.checkoutRunId !== identity.runId || issue.executionRunId !== identity.runId
    || issue.status !== "in_progress") return "assignment_changed";
  if (b.branch !== `review/${issue.identifier}` || !issue.projectId) return "policy_denied";

  const workspaces = await tx.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, identity.companyId), eq(projectWorkspaces.projectId, issue.projectId),
    ...(issue.projectWorkspaceId ? [eq(projectWorkspaces.id, issue.projectWorkspaceId)] : []),
  )).for("no key update");
  // Bindings accept only the lowercase identity without .git. URL suffixes do not create new identities.
  if (!workspaces.some((w) => w.repoUrl === `https://github.com/${b.repository}`
    || w.repoUrl === `https://github.com/${b.repository}.git`)) return "repository_denied";
  if (b.operation !== "push" && (b.sourceRepository !== b.repository
    || b.sourceBranch !== b.branch || b.headSha !== b.commitSha)) return "source_mismatch";
  return null;
}

export async function readAuthorityTime(tx: PublicationTransaction, companyId: string, clock: AuthorityClock) {
  // Registration must provision this row. A missing record never initializes its own authority.
  const [row] = await tx.select().from(publicationAuthorityClocks)
    .where(eq(publicationAuthorityClocks.companyId, companyId)).for("no key update");
  if (!row || row.uncertain) return null;
  const now = await clock(tx);
  if (now === null || !Number.isSafeInteger(now.wallMs) || !Number.isSafeInteger(now.monotonicMs)
    || now.epoch !== row.clockEpoch || now.wallMs < row.lastTimeMs || now.monotonicMs < row.lastMonotonicMs) {
    await tx.update(publicationAuthorityClocks).set({ uncertain: true })
      .where(eq(publicationAuthorityClocks.companyId, companyId));
    return null;
  }
  await tx.update(publicationAuthorityClocks).set({ lastTimeMs: now.wallMs, lastMonotonicMs: now.monotonicMs })
    .where(eq(publicationAuthorityClocks.companyId, companyId));
  return now;
}

export async function lockPublicationBroker(tx: PublicationTransaction, identity: PublicationIdentity, now: number) {
  const [broker] = await tx.select().from(publicationBrokers).where(and(
    eq(publicationBrokers.companyId, identity.companyId), eq(publicationBrokers.id, identity.brokerId),
  )).for("no key update");
  return broker && broker.certificateId === identity.certificateId && broker.issuerId === identity.issuerId
    && !broker.revokedAt && !broker.issuerRevoked && broker.validFromMs <= now && now < broker.validUntilMs
    ? broker : null;
}
