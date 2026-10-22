import { once } from "node:events";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, heartbeatRuns, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockedHeartbeat = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
    ...actual.heartbeatService(...args), wakeup: mockedHeartbeat.wakeup,
  }) };
});
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
describeDatabase("review bridge wait routes", () => {
  const f = bridgeFixture();
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function app(actor?: Express.Request["actor"]) {
    mockedHeartbeat.wakeup.mockImplementation(f.enqueue);
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = actor ?? { type: "board", userId: "board", companyIds: [f.companyId], isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    result.use("/api", issueRoutes(f.db, {} as never));
    result.use(errorHandler);
    const server = result.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    return server;
  }
  it.each(["false", "true"])("accepts a saved owner wait without an immediate self wake, guard=%s", async guard => {
    vi.stubEnv("PAPERCLIP_SELF_BLOCK_GUARD", guard);
    await f.handoff();
    const [run] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: f.issue.id } }).returning();
    await f.db.update(issues).set({ checkoutRunId: run!.id, executionRunId: run!.id }).where(eq(issues.id, f.issue.id));
    const response = await request(await app({ type: "agent", companyId: f.companyId,
      agentId: f.agentId, runId: run!.id, source: "agent_jwt" })).patch(`/api/issues/${f.issue.id}`)
      .send({ status: "blocked", unblockDescriptor: f.wait });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await f.current()).status).toBe("blocked");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(await f.db.select().from(issueThreadInteractions)).toEqual([]);
  });
  it("restarts stopped disposition recovery on explicit board resume", async () => {
    await f.park();
    await f.db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issue.id,
      kind: "deliberate_wait_without_target", status: "resolved", cause: "deliberate_wait_without_target",
      fingerprint: randomUUID(), nextAction: "Automatic recovery stopped.", evidence: { automaticRecovery: { replay: "blocked" } } });
    const response = await request(await app()).post(`/api/issues/${f.issue.id}/comments`)
      .send({ body: "Continue this issue.", resume: true });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect((await f.current()).status).toBe("todo");
    await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
    expect((await f.db.select().from(issueRecoveryActions))[0]).toMatchObject({ status: "resolved",
      evidence: { automaticRecovery: { replay: "not_required" } } });
  });
  it("releases a matching comment through one durable wake", async () => {
    await f.park();
    const response = await request(await app()).post(`/api/issues/${f.issue.id}/comments`).send({ body: f.eventBody() });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ reason: "review_bridge_event" });
    expect((await f.current()).status).toBe("todo");
  });
  it("ignores a stale comment and keeps the current wait", async () => {
    await f.park();
    const response = await request(await app()).post(`/api/issues/${f.issue.id}/comments`).send({ body: f.eventBody({ head: "b".repeat(40) }) });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await f.current()).status).toBe("blocked");
  });
  it("releases a document write without a wake marker", async () => {
    await f.park();
    const response = await request(await app()).put(`/api/issues/${f.issue.id}/documents/bridge`).send({ body: f.eventBody(), format: "markdown", title: "Bridge verdict" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0][1]).toMatchObject({ reason: "review_bridge_event" });
  });
});
