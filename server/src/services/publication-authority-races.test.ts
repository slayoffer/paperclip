import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, heartbeatRuns, issues, projectWorkspaces, publicationAuthorityClocks, publicationBrokers,
} from "@paperclipai/db";
import { publicationAuthorityService } from "./publication-authority.js";
import type { PublicationTransaction } from "./publication-authority-context.js";
import { authorityFixture, barrier, startAuthorityDatabase, waitForDatabaseWait } from "./publication-authority.test-fixture.js";

describe("publication decisions serialize with authoritative database writers", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  beforeAll(async () => { storage = await startAuthorityDatabase(); }, 90_000);
  afterAll(async () => { await storage?.database.cleanup(); });
  type Fixture = Awaited<ReturnType<typeof authorityFixture>>;

  const writers: [string, (tx: PublicationTransaction, f: Fixture) => PromiseLike<unknown>][] = [
    ["agent assignment", (tx, f) => tx.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.bindings.issueId))],
    ["user assignment", (tx, f) => tx.update(issues).set({ assigneeAgentId: null, assigneeUserId: "synthetic-user" }).where(eq(issues.id, f.bindings.issueId))],
    ["checkout release", (tx, f) => tx.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, f.bindings.issueId))],
    ["execution release", (tx, f) => tx.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.bindings.issueId))],
    ["issue cancellation", (tx, f) => tx.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.bindings.issueId))],
    ["run cancellation", (tx, f) => tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.identity.runId))],
    ["run identity", (tx, f) => tx.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.identity.runId))],
    ["agent pause", (tx, f) => tx.update(agents).set({ status: "paused" }).where(eq(agents.id, f.identity.agentId))],
    ["company pause", (tx, f) => tx.update(companies).set({ status: "paused" }).where(eq(companies.id, f.identity.companyId))],
    ["repository change", (tx, f) => tx.update(projectWorkspaces).set({ repoUrl: "https://github.com/synthetic/other" }).where(eq(projectWorkspaces.id, f.workspaceId))],
    ["broker revocation", (tx, f) => tx.update(publicationBrokers).set({ revokedAt: new Date() }).where(eq(publicationBrokers.id, f.identity.brokerId))],
    ["issuer revocation", (tx, f) => tx.update(publicationBrokers).set({ issuerRevoked: true }).where(eq(publicationBrokers.id, f.identity.brokerId))],
    ["certificate replacement", (tx, f) => tx.update(publicationBrokers).set({ certificateId: "replacement" }).where(eq(publicationBrokers.id, f.identity.brokerId))],
    ["clock uncertainty", (tx, f) => tx.update(publicationAuthorityClocks).set({ uncertain: true }).where(eq(publicationAuthorityClocks.companyId, f.identity.companyId))],
  ];

  it.each(writers)("denies dispatch after earlier committed %s", async (_, mutate) => {
    const f = await authorityFixture(storage.db);
    await f.service.request(f.identity, f.bindings);
    const updated = barrier(), release = barrier();
    let pid = 0;
    const writer = storage.db.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      pid = row!.pid;
      await mutate(tx, f);
      updated.release();
      await release.ready;
    });
    await updated.ready;
    const dispatch = f.service.dispatch(f.identity, f.bindings);
    try {
      await waitForDatabaseWait(storage.db, pid);
    } finally {
      release.release();
      await writer;
    }
    expect((await dispatch).dispatch).toBe(false);
  });

  it("serializes the request revocation method before dispatch", async () => {
    const f = await authorityFixture(storage.db);
    await f.service.request(f.identity, f.bindings);
    const locked = barrier(), release = barrier();
    let pid = 0, calls = 0;
    const revoker = publicationAuthorityService(storage.db, { clock: async (tx) => {
      if (++calls === 1) {
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pid = row!.pid;
        locked.release();
        await release.ready;
      }
      return f.clock();
    } });
    const revocation = revoker.revoke(f.identity, f.bindings);
    await locked.ready;
    const dispatch = f.service.dispatch(f.identity, f.bindings);
    try {
      await waitForDatabaseWait(storage.db, pid);
    } finally {
      release.release();
      await revocation;
    }
    expect(await dispatch).toMatchObject({ dispatch: false, state: "revoked" });
  });

  it("permits dispatch when its transaction precedes assignment or revocation", async () => {
    const f = await authorityFixture(storage.db);
    await f.service.request(f.identity, f.bindings);
    const locked = barrier(), release = barrier();
    let pid = 0, calls = 0;
    const authority = publicationAuthorityService(storage.db, { clock: async (tx) => {
      if (++calls === 2) {
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pid = row!.pid;
        locked.release();
        await release.ready;
      }
      return f.clock();
    } });
    const dispatch = authority.dispatch(f.identity, f.bindings);
    await locked.ready;
    const assignment = storage.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.bindings.issueId)).execute();
    const revocation = f.service.revoke(f.identity, f.bindings);
    try {
      await waitForDatabaseWait(storage.db, pid);
    } finally {
      release.release();
    }
    expect((await dispatch).dispatch).toBe(true);
    await Promise.all([assignment, revocation]);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(false);
  });

  it("fails closed on storage failure and rolls back dispatch with its audit", async () => {
    const f = await authorityFixture(storage.db);
    await f.service.request(f.identity, f.bindings);
    // The fixture owns this isolated database. A failing audit proves atomic rollback.
    await storage.db.execute(sql`create function synthetic_refuse_audit() returns trigger language plpgsql as $$
      begin raise exception 'synthetic audit storage failure'; end $$`);
    await storage.db.execute(sql`create trigger synthetic_refuse_audit before insert on activity_log
      for each row execute function synthetic_refuse_audit()`);
    try {
      await expect(f.service.dispatch(f.identity, f.bindings)).rejects.toThrow();
    } finally {
      await storage.db.execute(sql`drop trigger synthetic_refuse_audit on activity_log`);
      await storage.db.execute(sql`drop function synthetic_refuse_audit()`);
    }
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
    const { createDb } = await import("@paperclipai/db");
    const disconnected = createDb(storage.database.connectionString);
    await disconnected.$client.end();
    await expect(publicationAuthorityService(disconnected, { clock: f.clock }).dispatch(f.identity, f.next())).rejects.toThrow();
  });
});
