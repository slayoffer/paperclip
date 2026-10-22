import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, getEmbeddedPostgresTestSupport } from "@paperclipai/db";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";
import { heartbeatService } from "../services/heartbeat.js";
import { dispatchBridgeWakes } from "../services/review-bridge-wakes.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("bridge wake admission", () => {
  const f = bridgeFixture();
  it("cancels a wake when a new wait replaces it during admission", async () => {
    await f.park();
    await f.event();
    await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", status: "escalated", cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: f.agentId, fingerprint: randomUUID(), nextAction: "Check provider actions." });
    const heartbeat = heartbeatService(f.db);
    await dispatchBridgeWakes(f.db, async (agentId, opts) => {
      await f.db.update(issues).set({ status: "blocked", statusVersion: 2,
        unblockDescriptor: { ...f.wait, bridge: { ...f.wait.bridge, waitId: randomUUID() } },
      }).where(eq(issues.id, f.issue.id));
      return heartbeat.wakeup(agentId, opts);
    }, { companyId: f.companyId });
    await dispatchBridgeWakes(f.db, heartbeat.wakeup, { companyId: f.companyId });
    const rows = await f.db.select().from(agentWakeupRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
    expect(await f.db.select().from(heartbeatRuns)).toEqual([]);
    expect((await f.current()).status).toBe("blocked");
  });
  it("keeps execution holds and admits one deferred receipt", async () => {
    await f.park();
    await f.event();
    await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", status: "escalated", cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: f.agentId, fingerprint: randomUUID(), nextAction: "Check provider actions." });
    const heartbeat = heartbeatService(f.db);
    const dispatch = () => dispatchBridgeWakes(f.db, heartbeat.wakeup, { companyId: f.companyId });
    await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await dispatch();
    expect((await f.db.select().from(agentWakeupRequests)).some(row => row.status === "pending_bridge_dispatch")).toBe(true);
    expect(await f.db.select().from(heartbeatRuns)).toEqual([]);
    await f.db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await dispatch();
    await dispatch();
    const rows = await f.db.select().from(agentWakeupRequests);
    expect(rows.filter(row => row.status === "completed_bridge_dispatch")).toHaveLength(1);
    expect(rows.filter(row => row.status === "deferred_issue_execution")).toHaveLength(1);
    expect(rows.find(row => row.status === "deferred_issue_execution")).toMatchObject({
      reason: "review_bridge_event", runId: null, payload: { issueId: f.issue.id },
    });
    expect(await f.db.select().from(heartbeatRuns)).toEqual([]);
    expect((await f.db.select().from(issueRecoveryActions))[0].status).toBe("escalated");
    const [intent] = rows.filter(row => row.status === "completed_bridge_dispatch");
    await f.db.update(agentWakeupRequests).set({ status: "pending_bridge_dispatch" }).where(eq(agentWakeupRequests.id, intent.id));
    await dispatch();
    expect((await f.db.select().from(agentWakeupRequests)).filter(row => row.status === "deferred_issue_execution")).toHaveLength(1);
  });
});
