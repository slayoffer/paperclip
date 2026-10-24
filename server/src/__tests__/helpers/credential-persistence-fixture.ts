import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, toolApplications, toolConnections, toolProfiles, toolProfileEntries, toolProfileBindings, toolConnectionInstalls } from "@paperclipai/db";
import { startAdapterExecutionTargetPaperclipBridge } from "@paperclipai/adapter-utils/execution-target";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { heartbeatService } from "../../services/heartbeat.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

/** Local synthetic transports only. This fixture never contacts a provider or an installed server. */
export async function persistenceFixture() {
  const postgres = await startEmbeddedPostgresTestDatabase("credential-matrix-");
  const db = createDb(postgres.connectionString);
  const heartbeat = heartbeatService(db);
  return {
    db, heartbeat,
    async complete(issueId: string) { await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId)); },
    async close() {
      await heartbeat.drainActiveRunExecutions();
      await db.$client.end({ timeout: 0 });
      await postgres.cleanup();
    },
    async seed() {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Synthetic", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
      await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: { command: process.execPath }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } }, permissions: {} });
      await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic", status: "todo", priority: "high",
        assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
      const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: `synthetic-${companyId}`, name: "Synthetic", type: "mcp_http", status: "active" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Synthetic", uid: `test/${companyId}`,
        transport: "mcp_remote", status: "active", enabled: true, config: { url: "https://synthetic.invalid/mcp" } }).returning();
      const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `test:${companyId}`, name: "Synthetic", defaultAction: "deny" }).returning();
      await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", applicationId: application!.id, connectionId: connection!.id });
      await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
      await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
      return { companyId, agentId, issueId };
    },
    async start(binding: { agentId: string; issueId: string }) {
      await heartbeat.wakeup(binding.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: binding.issueId }, contextSnapshot: { issueId: binding.issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system", requestedByActorId: "issue_assignment" });
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, binding.agentId)))[0]!;
    },
    async read(id: string) {
      const row = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
      const log = row.logRef ? (await heartbeat.readLog(id, { limitBytes: 1_000_000 })).content : "";
      const chunks = log.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      return { row, log, chunks, reconstructed: chunks.map(chunk => chunk.chunk ?? "").join("") };
    },
  };
}

export async function localSyntheticBridge(ctx: AdapterExecutionContext) {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-bridge-"));
  try {
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: ctx.runId, runtimeRootDir: root, adapterKey: "synthetic", hostApiToken: ctx.authToken,
      hostApiUrl: "http://127.0.0.1:1", registerSecretValue: ctx.registerSecretValue,
      target: { kind: "remote", transport: "sandbox", providerKey: "local-test", remoteCwd: root,
        streamRunLogs: false,
        runner: { execute: input => runChildProcess(ctx.runId, input.command, input.args ?? [], {
          cwd: input.cwd ?? root, env: input.env ?? {}, stdin: input.stdin, timeoutSec: 15, graceSec: 1, onLog: async () => {},
        }) },
      },
    });
    if (!bridge) throw new Error("Synthetic bridge did not start");
    return { ...bridge, close: async () => { await bridge.stop(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
