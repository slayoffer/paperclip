import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb, companies, agents, issues, documents, issueDocuments, issueThreadInteractions,
  toolApplications, toolConnections, connectionGrants, companySecrets, userSecretDefinitions, credentialTransfers,
  companyMemberships, heartbeatRuns, toolCatalogEntries, toolProfiles, toolProfileBindings, toolPolicies,
  type Db,
} from "@paperclipai/db";
import { companyService } from "../services/companies.js";
import { credentialTransferAuthority } from "../services/credential-transfer-authority.js";
import { credentialTransferJournal } from "../services/credential-transfer-journal.js";
import { credentialTransferService } from "../services/credential-transfer.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { transferFixture, CANARIES } from "./helpers/credential-transfer-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

databaseSuite("credential transfer saved authority and journal", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-credential-transfer-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const f = transferFixture();
    await db.insert(companies).values({ id: f.actor.companyId, name: "Transfer test", issuePrefix: `T${randomUUID().slice(0, 8)}` });
    await db.insert(agents).values({ id: f.actor.agentId, companyId: f.actor.companyId, name: "Test executor", adapterType: "process" });
    await db.insert(issues).values({ id: f.actor.issueId, companyId: f.actor.companyId, title: "Approved test operation", status: "in_progress" });
    for (const side of ["source", "destination"] as const) {
      const binding = f.request[side];
      const appId = randomUUID();
      const secretId = Object.keys(binding.credentialVersions)[0]!;
      const definitionId = randomUUID();
      await db.insert(toolApplications).values({ id: appId, companyId: f.actor.companyId, name: side, type: "mcp_http" });
      await db.insert(toolConnections).values({ id: binding.connectionId, companyId: f.actor.companyId, applicationId: appId,
        name: side, uid: side, transport: "mcp_remote", credentialPolicy: "per_user", enabled: true, status: "active",
        updatedAt: new Date(binding.connectionVersion) });
      await db.insert(userSecretDefinitions).values({ id: definitionId, companyId: f.actor.companyId, key: side, name: side });
      await db.insert(companySecrets).values({ id: secretId, companyId: f.actor.companyId, key: side, name: side, scope: "user",
        ownerUserId: f.actor.userId, userSecretDefinitionId: definitionId });
      await db.insert(connectionGrants).values({ id: binding.grantId, companyId: f.actor.companyId, connectionId: binding.connectionId,
        kind: "user", subjectUserId: f.actor.userId, updatedAt: new Date(binding.grantVersion),
        credentialSecretRefs: [{ secretId, configPath: "TOKEN", versionSelector: "latest" }] });
    }
    for (const [key, ref, kind] of [
      ["permission", f.request.permissionApproval, "r2_permission_window"],
      ["issuance", f.request.issuanceApproval, "r2_credential_transfer"],
    ] as const) {
      await db.insert(documents).values({ id: ref.documentId, companyId: f.actor.companyId,
        latestRevisionId: ref.revisionId, latestBody: JSON.stringify({ ...f.operation, operation: kind }) });
      await db.insert(issueDocuments).values({ companyId: f.actor.companyId, issueId: f.actor.issueId, documentId: ref.documentId, key });
      await db.insert(issueThreadInteractions).values({ id: ref.interactionId, companyId: f.actor.companyId, issueId: f.actor.issueId,
        kind: "request_confirmation", status: "accepted", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
        addresseeUserId: f.actor.userId, resolvedByUserId: f.actor.userId,
        payload: { version: 1, prompt: "Execute only this test operation.", target: {
          type: "issue_document", issueId: f.actor.issueId, key, documentId: ref.documentId, revisionId: ref.revisionId,
        } }, result: { version: 1, outcome: "accepted" } });
    }
    const gateway = { authorizeCredentialTransfer: vi.fn().mockResolvedValue(undefined) };
    const authority = credentialTransferAuthority(db, gateway, "fake-session", { source: ["fake-issue"], destination: ["fake-create"] });
    const check = () => authority.check(f.actor, f.request);
    return Object.assign(f, { gateway, authority, check });
  }

  it("binds both accepted human revisions and both personal connection versions", async () => {
    const f = await seed();
    expect(await f.check()).toEqual(f.operation);
    expect(f.gateway.authorizeCredentialTransfer).toHaveBeenCalledTimes(2);
    expect(f.gateway.authorizeCredentialTransfer.mock.calls[0]![0]).toMatchObject({
      sessionToken: "fake-session", ...f.actor, connectionId: f.request.source.connectionId, grantId: f.request.source.grantId,
    });
  });

  it.each([
    ["pending approval", { status: "pending" }],
    ["agent-resolvable approval", { effectiveResolverPolicy: "anyone" }],
    ["different human", { resolvedByUserId: "another-person" }],
    ["missing acceptance", { result: null }],
  ])("rejects %s before gateway access", async (_name, patch) => {
    const f = await seed();
    await db.update(issueThreadInteractions).set(patch as Partial<typeof issueThreadInteractions.$inferInsert>)
      .where(eq(issueThreadInteractions.id, f.request.issuanceApproval.interactionId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
    expect(f.gateway.authorizeCredentialTransfer).not.toHaveBeenCalled();
  });

  it("rejects a stale document revision and a changed operation", async () => {
    const f = await seed();
    await db.update(documents).set({ latestRevisionId: randomUUID() }).where(eq(documents.id, f.request.issuanceApproval.documentId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
    await db.update(documents).set({ latestRevisionId: f.request.issuanceApproval.revisionId,
      latestBody: JSON.stringify({ ...f.operation, bucket: "other-bucket" }) }).where(eq(documents.id, f.request.issuanceApproval.documentId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
  });

  it.each(["source", "destination"] as const)("rejects changed %s bindings", async side => {
    const f = await seed();
    await db.update(toolConnections).set({ updatedAt: new Date() }).where(eq(toolConnections.id, f.request[side].connectionId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a shared Infisical identity and credential rotation", async () => {
    const f = await seed();
    const binding = f.request.destination;
    await db.update(toolConnections).set({ credentialPolicy: "shared" }).where(eq(toolConnections.id, binding.connectionId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
    await db.update(toolConnections).set({ credentialPolicy: "per_user" }).where(eq(toolConnections.id, binding.connectionId));
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, Object.keys(binding.credentialVersions)[0]!));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
  });

  it("rejects company and saved grant ownership changes", async () => {
    const f = await seed();
    await expect(f.authority.check({ ...f.actor, companyId: randomUUID() }, f.request)).rejects.toMatchObject({ status: 403 });
    await db.update(connectionGrants).set({ subjectUserId: "different-person" }).where(eq(connectionGrants.id, f.request.destination.grantId));
    await expect(f.check()).rejects.toMatchObject({ status: 403 });
  });

  it("cannot override a denied gateway tool with operation approval", async () => {
    const f = await seed();
    f.gateway.authorizeCredentialTransfer.mockRejectedValue(new Error("denied"));
    const journal = credentialTransferJournal(db);
    const service = credentialTransferService({ authority: f.authority, journal, providers: f.providers,
      now: () => Date.parse("2026-10-18T12:00:00.000Z") });
    await expect(service.execute(f.actor, f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.trace).toEqual([]);
    expect(await journal.unfinished(f.actor.companyId)).toEqual([]);
  });

  it("uses the live gateway policy and authenticated run identity without provider calls", async () => {
    const f = await seed();
    await db.insert(companyMemberships).values({ companyId: f.actor.companyId, principalType: "user",
      principalId: f.actor.userId, status: "active", membershipRole: "member" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.actor.companyId, agentId: f.actor.agentId,
      status: "running", contextSnapshot: { issueId: f.actor.issueId } }).returning();
    await initializeRunIdentity(db, { companyId: f.actor.companyId, runId: run!.id,
      responsibleUserId: f.actor.userId, cause: "test" });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.request.source.connectionId));
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.actor.companyId,
      applicationId: connection!.applicationId, connectionId: connection!.id, entryKind: "tool", name: "fake-issue",
      toolName: "fake-issue", status: "active", riskLevel: "write", isWrite: true, isReadOnly: false,
      versionHash: randomUUID(), schemaHash: randomUUID(), inputSchema: { type: "object" } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.actor.companyId,
      profileKey: "transfer-test", name: "Transfer test", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.actor.companyId, profileId: profile!.id,
      targetType: "agent", targetId: f.actor.agentId });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: async () => { throw new Error("Network access is forbidden"); } });
    const session = await gateway.createSession({ companyId: f.actor.companyId, agentId: f.actor.agentId, runId: run!.id });
    const tool = (await gateway.listToolsForSession(session.token)).find(value => value.connectionId === connection!.id)!;
    expect(tool).toBeDefined();
    const binding = { ...f.actor, sessionToken: session.token, connectionId: connection!.id,
      grantId: f.request.source.grantId, toolNames: [tool.name], operation: f.operation };
    await expect(gateway.authorizeCredentialTransfer(binding)).resolves.toBeUndefined();
    await expect(gateway.authorizeCredentialTransfer({ ...binding, userId: "another-person" })).rejects.toMatchObject({ status: 403 });
    await expect(gateway.authorizeCredentialTransfer({ ...binding, issueId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(gateway.authorizeCredentialTransfer({ ...binding, grantId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    const [policy] = await db.insert(toolPolicies).values({ companyId: f.actor.companyId, name: "Ask first",
      policyType: "require_approval", selectors: { catalogEntryId: entry!.id } }).returning();
    await expect(gateway.authorizeCredentialTransfer(binding)).rejects.toMatchObject({ status: 403 });
    await db.update(toolPolicies).set({ policyType: "block" }).where(eq(toolPolicies.id, policy!.id));
    await expect(gateway.authorizeCredentialTransfer(binding)).rejects.toMatchObject({ status: 403 });
    // An operation approval must not bypass an argument-dependent destination denial.
    await db.update(toolPolicies).set({ conditions: { arguments: { fieldEquals: { path: "/clpn-ha" } } } })
      .where(eq(toolPolicies.id, policy!.id));
    await expect(gateway.authorizeCredentialTransfer(binding)).rejects.toMatchObject({ status: 403 });
    await db.update(toolPolicies).set({ conditions: { arguments: { fieldEquals: { path: "/other" } } } })
      .where(eq(toolPolicies.id, policy!.id));
    await expect(gateway.authorizeCredentialTransfer(binding)).resolves.toBeUndefined();
    // Missing or secret-dependent arguments cannot establish a safe policy decision.
    await db.update(toolPolicies).set({ conditions: { arguments: { fieldEquals: { secretValue: "secret" } } } })
      .where(eq(toolPolicies.id, policy!.id));
    await expect(gateway.authorizeCredentialTransfer(binding)).rejects.toMatchObject({ status: 403 });
    expect(f.trace).toEqual([]);
  });

  it("persists restart cleanup and refuses concurrent executors or approval replay", async () => {
    const f = await seed();
    const journal = credentialTransferJournal(db);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const first = journal.exclusive(f.actor.companyId, f.request.destination.connectionId, async () => { entered(); await held; });
    await locked;
    await expect(credentialTransferJournal(db).exclusive(f.actor.companyId, f.request.destination.connectionId,
      async () => undefined)).rejects.toMatchObject({ status: 409 });
    await expect(credentialTransferJournal(db).exclusive(f.actor.companyId, randomUUID(),
      async () => undefined)).rejects.toMatchObject({ status: 409 });
    release();
    await first;
    f.setFailure("cleanup");
    const service = () => credentialTransferService({ authority: f.authority, journal: credentialTransferJournal(db), providers: f.providers,
      now: () => Date.parse("2026-10-18T12:00:00.000Z") });
    const receipt = await service().execute(f.actor, f.request);
    expect(receipt.state).toBe("cleanup_required");
    f.setFailure(null);
    expect((await service().recover(f.actor.companyId))[0]?.state).toBe("revoked");
    expect(f.issueCount).toBe(1);
    expect(f.grants).toEqual(new Set(["b".repeat(32)]));
    expect(await journal.get(randomUUID(), receipt.id)).toBeNull();
    await expect(service().execute(f.actor, f.request)).rejects.toMatchObject({ status: 409 });
    const persisted = await db.select().from(credentialTransfers).where(and(eq(credentialTransfers.companyId, f.actor.companyId),
      eq(credentialTransfers.id, receipt.id)));
    for (const canary of CANARIES) expect(JSON.stringify(persisted)).not.toContain(canary);
  });
  it("retains the lock across provider delays beyond idle and lifetime settings", async () => {
    const slowDb = createDb(database.connectionString, { idleTimeoutSeconds: 1, maxLifetimeSeconds: 1 });
    const f = await seed();
    const originalArm = f.providers.arm.bind(f.providers);
    f.providers.arm = async input => {
      await originalArm(input);
      await new Promise(resolve => setTimeout(resolve, 2500));
      await expect(credentialTransferJournal(db).exclusive(f.actor.companyId, randomUUID(),
        async () => { throw new Error("Second executor entered"); })).rejects.toMatchObject({ status: 409 });
    };
    const service = credentialTransferService({ authority: f.authority, journal: credentialTransferJournal(slowDb),
      providers: f.providers, now: () => Date.parse("2026-10-18T12:00:00.000Z") });
    expect((await service.execute(f.actor, f.request)).state).toBe("complete");
    await slowDb.$client.end();
  });

  it("fences subsequent provider effects when the reserved backend is lost", async () => {
    const f = await seed();
    const originalArm = f.providers.arm.bind(f.providers);
    f.providers.arm = async input => {
      await originalArm(input);
      const key = `credential-transfer:${f.actor.companyId}`;
      // Terminate only this disposable test's lock backend.
      const killed = await db.execute(sql`select pg_terminate_backend(pid) as killed from pg_locks
        where locktype = 'advisory' and granted
          and classid = (hashtextextended(${key}, 0) >> 32)::int::oid
          and objid = (hashtextextended(${key}, 0) & 4294967295)::oid and objsubid = 1`);
      expect(killed).toHaveLength(1);
      expect(killed[0]?.killed).toBe(true);
    };
    const service = credentialTransferService({ authority: f.authority, journal: credentialTransferJournal(db),
      providers: f.providers, now: () => Date.parse("2026-10-18T12:00:00.000Z") });
    await expect(service.execute(f.actor, f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.trace).not.toContain("activate");
    expect(f.issueCount).toBe(0);
    expect(f.trace).toContain("cleanup");
    expect((await db.select().from(credentialTransfers).where(eq(credentialTransfers.companyId, f.actor.companyId)))[0]?.state)
      .toBe("revoked");
  });

  it.each(["complete", "revoked"] as const)("removes a company with a %s journal", async state => {
    const f = transferFixture();
    await db.insert(companies).values({ id: f.actor.companyId, name: "Settled transfer", issuePrefix: `T${randomUUID().slice(0, 8)}` });
    await credentialTransferJournal(db).insert({ id: randomUUID(), actor: f.actor, bindings: f.request,
      operation: f.operation, state, baselineGrantIds: [], cleanupTicketId: null, credentialId: null,
      storedNames: [], failureCode: null });
    expect((await companyService(db).remove(f.actor.companyId))?.id).toBe(f.actor.companyId);
    expect(await db.select().from(credentialTransfers).where(eq(credentialTransfers.companyId, f.actor.companyId))).toEqual([]);
  });

  it.each(["prepared", "armed", "issuing", "storing", "cleanup_required"] as const)(
    "preserves company and %s cleanup journal during removal", async state => {
      const f = transferFixture();
      await db.insert(companies).values({ id: f.actor.companyId, name: "Unfinished transfer", issuePrefix: `T${randomUUID().slice(0, 8)}` });
      const row = { id: randomUUID(), actor: f.actor, bindings: f.request, operation: f.operation, state,
        baselineGrantIds: [], cleanupTicketId: randomUUID(), credentialId: null, storedNames: [], failureCode: null };
      await credentialTransferJournal(db).insert(row);
      await expect(companyService(db).remove(f.actor.companyId)).rejects.toMatchObject({ status: 422 });
      expect(await credentialTransferJournal(db).get(f.actor.companyId, row.id)).toEqual(row);
      expect(await db.select().from(companies).where(eq(companies.id, f.actor.companyId))).toHaveLength(1);
    });

});
