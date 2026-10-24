import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companyMemberships, heartbeatRuns, toolCatalogEntries, toolConnections, toolProfiles,
  toolProfileBindings, toolPolicies, toolRateLimitCounters, documents, issueDocuments, issueThreadInteractions,
  type Db } from "@paperclipai/db";
import { credentialTransferAuthority, type TransferToolMap } from "../services/credential-transfer-authority.js";
import { credentialTransferService } from "../services/credential-transfer.js";
import { credentialTransferJournal } from "../services/credential-transfer-journal.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { seedTransferAuthority } from "./helpers/credential-transfer-authority-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

databaseSuite("credential transfer provider quota", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-transfer-quota-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function setup(limitedTool: string, limit: number) {
    const f = await seedTransferAuthority(db);
    await db.insert(companyMemberships).values({ companyId: f.actor.companyId, principalType: "user",
      principalId: f.actor.userId, status: "active", membershipRole: "member" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.actor.companyId, agentId: f.actor.agentId,
      status: "running", contextSnapshot: { issueId: f.actor.issueId } }).returning();
    await initializeRunIdentity(db, { companyId: f.actor.companyId, runId: run!.id,
      responsibleUserId: f.actor.userId, cause: "test" });
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.actor.companyId,
      profileKey: "transfer-quota", name: "Transfer quota", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.actor.companyId, profileId: profile!.id,
      targetType: "agent", targetId: f.actor.agentId });
    const entries = [];
    for (const side of ["source", "destination"] as const) {
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.request[side].connectionId));
      for (const name of side === "source" ? ["inspect", "arm", "activate", "issue"] : ["createOnly", "readCreated"]) {
        const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.actor.companyId,
          applicationId: connection!.applicationId, connectionId: connection!.id, entryKind: "tool", name,
          toolName: name, status: "active", riskLevel: "write", isWrite: true, isReadOnly: false,
          versionHash: randomUUID(), schemaHash: randomUUID(), inputSchema: { type: "object" } }).returning();
        entries.push({ side, name, entry: entry! });
      }
    }
    const [policy] = await db.insert(toolPolicies).values({ companyId: f.actor.companyId, name: "Shared hourly quota",
      policyType: "rate_limit", selectors: { catalogEntryId: entries.find(e => e.name === limitedTool)!.entry.id },
      config: { limit, windowSeconds: 3600, keyBy: ["agent", "tool"] } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: async () => { throw new Error("Network access is forbidden"); } });
    const session = await gateway.createSession({ companyId: f.actor.companyId, agentId: f.actor.agentId, runId: run!.id });
    const tools = await gateway.listToolsForSession(session.token);
    const operations = {} as TransferToolMap;
    const names = { source: [] as string[], destination: [] as string[] };
    for (const { side, name, entry } of entries) {
      const tool = tools.find(t => t.catalogEntryId === entry.id)!;
      expect(tool).toBeDefined();
      names[side].push(tool.name);
      operations[name as keyof TransferToolMap] = { [side]: [tool.name] };
    }
    const authority = credentialTransferAuthority(db, gateway, session.token, { ...names, operations });
    const service = credentialTransferService({ authority, journal: credentialTransferJournal(db), providers: f.providers,
      now: () => Date.parse("2026-10-18T12:00:00.000Z") });
    const counters = () => db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.policyId, policy!.id));
    return { f, authority, service, counters };
  }

  it("charges one source operation and refuses a successive approved transfer under the same limit", async () => {
    const { f, authority, service, counters } = await setup("issue", 1);
    await authority.check(f.actor, f.request);
    await authority.check(f.actor, f.request);
    expect(await counters()).toHaveLength(0);
    expect((await service.execute(f.actor, f.request)).state).toBe("complete");
    expect(f.issueCount).toBe(1);
    expect(await counters()).toMatchObject([{ limit: 1, remaining: 0 }]);
    // New accepted revisions authorize a separate transfer under the same policy and identity.
    for (const [key, kind] of [["permissionApproval", "r2_permission_window"], ["issuanceApproval", "r2_credential_transfer"]] as const) {
      const ref = { interactionId: randomUUID(), documentId: randomUUID(), revisionId: randomUUID() };
      f.request[key] = ref;
      await db.insert(documents).values({ id: ref.documentId, companyId: f.actor.companyId,
        latestRevisionId: ref.revisionId, latestBody: JSON.stringify({ ...f.operation, operation: kind }) });
      await db.insert(issueDocuments).values({ companyId: f.actor.companyId, issueId: f.actor.issueId,
        documentId: ref.documentId, key: ref.documentId });
      await db.insert(issueThreadInteractions).values({ id: ref.interactionId, companyId: f.actor.companyId, issueId: f.actor.issueId,
        kind: "request_confirmation", status: "accepted", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
        addresseeUserId: f.actor.userId, resolvedByUserId: f.actor.userId,
        payload: { version: 1, prompt: "Execute this separate fake transfer.", target: { type: "issue_document",
          issueId: f.actor.issueId, key: ref.documentId, documentId: ref.documentId, revisionId: ref.revisionId } },
        result: { version: 1, outcome: "accepted" } });
    }
    f.vault.clear();
    expect((await service.execute(f.actor, f.request)).state).toBe("revoked");
    expect(f.issueCount).toBe(1);
    expect(f.vault.size).toBe(0);
    expect([...f.grants]).toEqual(["b".repeat(32)]);
    expect(await counters()).toMatchObject([{ remaining: 0 }]);
    await expect(authority.check(f.actor, f.request)).resolves.toEqual(f.operation);
  }, 60_000);

  it.each(["createOnly", "readCreated"])("charges each %s call and preserves cleanup after exhaustion", async name => {
    const { f, service, counters } = await setup(name, 1);
    expect((await service.execute(f.actor, f.request)).state).toBe("revoked");
    expect(f.issueCount).toBe(1);
    expect(f.vault.size).toBe(name === "createOnly" ? 1 : 2);
    expect([...f.tickets.values()].every(t => t.revoked && t.closed)).toBe(true);
    expect([...f.grants]).toEqual(["b".repeat(32)]);
    expect(await counters()).toMatchObject([{ limit: 1, remaining: 0 }]);
  }, 60_000);

  it.each(["inspect", "arm", "activate"])("charges %s before its provider call", async name => {
    const { f, authority, service, counters } = await setup(name, 1);
    await authority.consume(f.actor, f.request, name as "inspect" | "arm" | "activate", f.operation);
    const result = service.execute(f.actor, f.request);
    if (name === "inspect") await expect(result).rejects.toMatchObject({ status: 409 });
    else expect((await result).state).toBe("revoked");
    expect(f.trace).not.toContain(name);
    expect(f.issueCount).toBe(0);
    expect([...f.grants]).toEqual(["b".repeat(32)]);
    expect(await counters()).toMatchObject([{ limit: 1, remaining: 0 }]);
  }, 60_000);
});
