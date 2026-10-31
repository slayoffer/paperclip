import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { agents, agentTaskSessions, authUsers, companies, companyMemberships,
  createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: (type: string) => ({
    ...actual.getServerAdapter(type), supportsLocalAgentJwt: false, execute,
  }) };
});

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

databaseTests("cap checkpoints before terminal success", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cap-finalization-home-"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-cap-finalization-");
    db = createDb(database.connectionString);
    // Observe the contract at the database write, before any later finalizer work can repair it.
    await db.execute(sql`create function require_cap_checkpoint() returns trigger language plpgsql as $$
      begin
        if new.status = 'succeeded' and new.result_json->>'stopReason' = 'run_token_cap'
          and not exists (select 1 from agent_task_sessions s
            where s.company_id = new.company_id and s.agent_id = new.agent_id
              and s.last_run_id = new.id and s.session_params_json->>'sessionId' = new.session_id_after)
        then raise exception 'cap_checkpoint_missing_at_terminal_success'; end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger require_cap_checkpoint before update of status on heartbeat_runs
      for each row execute function require_cap_checkpoint()`);
  }, 60_000);
  afterEach(async () => {
    await db.update(agents).set({ status: "paused" });
    await heartbeatService(db).drainActiveRunExecutions();
    execute.mockReset();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it.each([false, true])("preserves the checkpoint and execution scope with owner mode %s", async (owner) => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", String(owner));
    vi.stubEnv("PAPERCLIP_OWNER_SESSION_AGENT_IDS", "");
    vi.stubEnv("PAPERCLIP_ISSUE_TOKEN_BUDGET", "");
    const companyId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const responsibleUserId = randomUUID();
    const sourceSessionId = randomUUID();
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Owner",
      email: `${responsibleUserId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Cap finalization",
      issuePrefix: `F${companyId.slice(0, 6)}`, defaultResponsibleUserId: responsibleUserId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user",
      principalId: responsibleUserId, status: "active", membershipRole: "owner" });
    if (owner) await db.insert(projects).values({ id: projectId, companyId, name: "Owner scope" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Codex owner", role: "engineer",
      status: "idle", adapterType: "codex_local", adapterConfig: { engine: "cli" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue this capped run",
      projectId: owner ? projectId : null, status: "in_progress", assigneeAgentId: agent.id, responsibleUserId });
    const contexts: AdapterExecutionContext[] = [];
    execute.mockImplementation(async (ctx: AdapterExecutionContext) => {
      contexts.push(ctx);
      const continuation = !!ctx.context.runTokenCapSourceRunId;
      if (continuation) await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      const scope = ctx.context.paperclipOwnerSession as { localDirectory: string } | undefined;
      const workspace = ctx.context.paperclipWorkspace as { cwd: string };
      return { exitCode: 0, signal: null, timedOut: false, summary: continuation ? "Done." : "Continue B.",
        sessionId: sourceSessionId, sessionParams: { sessionId: sourceSessionId,
          cwd: scope?.localDirectory ?? workspace.cwd,
          ...(owner ? { ownerSession: true, ownerSessionIssueId: issueId } : {}),
        }, resultJson: continuation ? {} : { stopReason: "run_token_cap" },
      };
    });
    const heartbeat = heartbeatService(db);
    const source = await heartbeat.wakeup(agent.id, { source: "automation", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId }, contextSnapshot: { issueId } });
    expect(source).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(contexts).toHaveLength(2);
    expect(contexts[1].context.runTokenCapSourceRunId).toBe(source!.id);
    expect(contexts[1].runtime.sessionParams).toMatchObject({ sessionId: sourceSessionId });
    expect(contexts[1].context.resumeSessionParams).toBeUndefined();
    if (owner) {
      expect(contexts[0].context.paperclipOwnerSession).toMatchObject({ key: `owner-project:${projectId}` });
      expect(contexts[1].context.paperclipOwnerSession).toMatchObject({ key: `owner-project:${projectId}` });
    } else expect(contexts[1].context.paperclipOwnerSession).toBeUndefined();
    const saved = await db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agent.id),
    ));
    expect(saved).toHaveLength(1);
    expect(saved[0].lastRunId).toBe(contexts[1].runId);
    expect(saved[0].taskKey).toBe(owner ? `owner-project:${projectId}` : issueId);
    expect(await heartbeat.getRun(source!.id)).toMatchObject({ status: "succeeded", sessionIdAfter: sourceSessionId,
      resultJson: { stopReason: "run_token_cap" } });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const ledger = runs.map((run) => ({ status: run.status, wakeReason: run.contextSnapshot?.wakeReason,
      source: run.contextSnapshot?.runTokenCapSourceRunId, id: run.id }));
    expect(ledger, JSON.stringify(ledger)).toHaveLength(2);
  }, 60_000);
});
