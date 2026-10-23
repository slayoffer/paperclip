import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issues, projects, projectWorkspaces,
  publicationAuthorityClocks, publicationBrokers, startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import type { PublicationBindings, PublicationIdentity } from "@paperclipai/shared";
import { publicationAuthorityService } from "./publication-authority.js";

export async function startAuthorityDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-publication-authority-");
  return { database, db: createDb(database.connectionString, { applicationName: "publication-authority-tests" }) };
}

export async function authorityFixture(db: Db, initialTime = 1_800_000_000_000) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  const runId = randomUUID(), brokerId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID();
  const identity: PublicationIdentity = {
    companyId, agentId, runId, brokerId, certificateId: randomUUID(), issuerId: randomUUID(),
  };
  const prefix = `T${companyId.replaceAll("-", "").toUpperCase()}`;
  const bindings: PublicationBindings = {
    requestId: randomUUID(), companyId, agentId, runId, brokerId, issueId,
    repository: "synthetic/authority", branch: `review/${prefix}-1`, operation: "push",
    commitSha: "a".repeat(40), expectedOldSha: "b".repeat(40),
  };
  let now = initialTime;
  let monotonicMs = 10_000;
  const clock = async () => ({ wallMs: now, monotonicMs, epoch: "synthetic-epoch" });
  await db.insert(companies).values({ id: companyId, name: "Synthetic authority", issuePrefix: prefix });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic owner", role: "engineer", adapterType: "codex_local" });
  await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic repository" });
  await db.insert(projectWorkspaces).values({ id: workspaceId, companyId, projectId, name: "Synthetic workspace", repoUrl: "https://github.com/synthetic/authority" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
  await db.insert(issues).values({
    id: issueId, companyId, projectId, projectWorkspaceId: workspaceId, title: "Synthetic publication", identifier: `${prefix}-1`,
    status: "in_progress", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId,
  });
  await db.insert(publicationAuthorityClocks).values({ companyId, lastTimeMs: now, lastMonotonicMs: monotonicMs, clockEpoch: "synthetic-epoch" });
  await db.insert(publicationBrokers).values({
    id: brokerId, companyId, certificateId: identity.certificateId, issuerId: identity.issuerId,
    validFromMs: now - 10_000, validUntilMs: now + 100_000,
  });
  return {
    db, identity, bindings, workspaceId, clock,
    service: publicationAuthorityService(db, { clock }),
    advance: (ms: number) => { now += ms; monotonicMs += Math.max(0, ms); },
    advanceMonotonic: (ms: number) => { monotonicMs += ms; },
    next: () => ({ ...bindings, requestId: randomUUID() }),
  };
}

export function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

// Inspect PostgreSQL's lock graph. Elapsed time alone does not prove serialization.
export async function waitForDatabaseWait(db: Db, blockerPid: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await db.execute(sql`select pid from pg_stat_activity
      where ${blockerPid} = any(pg_blocking_pids(pid))`);
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected PostgreSQL row-lock wait did not occur");
}
