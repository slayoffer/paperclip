import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectWorkspaces, publicationRequests } from "@paperclipai/db";
import { publicationReconciliationService } from "./publication-authority-reconciliation.js";
import { authorityFixture, startAuthorityDatabase } from "./publication-authority.test-fixture.js";

describe("publication repository identities cannot bypass reconciliation", () => {
  let storage: Awaited<ReturnType<typeof startAuthorityDatabase>>;
  beforeAll(async () => { storage = await startAuthorityDatabase(); }, 90_000);
  afterAll(async () => { await storage?.database.cleanup(); });

  it.each(["dispatched", "unknown"] as const)("rejects aliases after an unresolved %s write", async (state) => {
    const f = await authorityFixture(storage.db);
    await storage.db.update(projectWorkspaces).set({ repoUrl: "https://github.com/synthetic/authority.git" })
      .where(eq(projectWorkspaces.id, f.workspaceId));
    await f.service.request(f.identity, f.bindings);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
    if (state === "unknown") await f.service.recordResult(f.identity, f.bindings, "unknown");

    for (const repository of ["synthetic/authority.git", "Synthetic/Authority", "synthetic/authority.GIT"]) {
      const alias = { ...f.next(), repository };
      await expect(f.service.request(f.identity, alias)).rejects.toThrow();
      await expect(f.service.dispatch(f.identity, alias)).rejects.toThrow();
      expect(await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, alias.requestId)))
        .toHaveLength(0);
    }

    const next = f.next();
    await f.service.request(f.identity, next);
    expect(await f.service.dispatch(f.identity, next)).toMatchObject({ dispatch: false, reason: "reconciliation_required" });
    expect(await publicationReconciliationService(storage.db, {
      companyId: f.identity.companyId, verifierId: "synthetic-protected-verifier",
      verify: async () => ({ result: "succeeded", evidenceId: randomUUID() }),
    }).reconcile(f.bindings)).toMatchObject({ reason: "reconciled" });
    expect((await f.service.dispatch(f.identity, next)).dispatch).toBe(true);
  });

  it.each(["create_pull_request", "update_pull_request"] as const)("rejects source aliases for %s", async (operation) => {
    const f = await authorityFixture(storage.db);
    const { expectedOldSha: _, ...common } = f.bindings as typeof f.bindings & { expectedOldSha: string };
    for (const sourceRepository of ["synthetic/authority.git", "Synthetic/Authority"]) {
      await expect(f.service.request(f.identity, {
        ...common, operation, sourceRepository, sourceBranch: common.branch,
        headSha: common.commitSha, ...(operation === "update_pull_request" ? { pullRequestNumber: 1 } : {}),
      })).rejects.toThrow();
    }
  });

  it("rejects direct SQL aliases and mismatched repository bindings", async () => {
    const f = await authorityFixture(storage.db);
    await f.service.request(f.identity, f.bindings);
    const [original] = await storage.db.select().from(publicationRequests).where(eq(publicationRequests.id, f.bindings.requestId));
    for (const repository of ["synthetic/authority.git", "Synthetic/Authority", "synthetic/authority.GIT"]) {
      const id = randomUUID();
      await expect(storage.db.insert(publicationRequests).values({
        ...original!, id, repository, bindings: { ...f.bindings, requestId: id, repository },
      })).rejects.toThrow();
    }
    for (const patch of [{ repository: "synthetic/other" }, { repository: "synthetic/authority.git" }, {
      operation: "create_pull_request" as const, sourceRepository: "synthetic/authority.git",
      sourceBranch: f.bindings.branch, headSha: f.bindings.commitSha,
    }]) {
      const id = randomUUID();
      await expect(storage.db.insert(publicationRequests).values({
        ...original!, id, bindings: { ...f.bindings, requestId: id, ...patch },
      })).rejects.toThrow();
    }
  });

  it("enforces one outstanding canonical identity at the database boundary", async () => {
    const f = await authorityFixture(storage.db), next = f.next();
    await f.service.request(f.identity, f.bindings);
    await f.service.request(f.identity, next);
    expect((await f.service.dispatch(f.identity, f.bindings)).dispatch).toBe(true);
    await expect(storage.db.update(publicationRequests).set({ state: "dispatched", dispatchedAtMs: (await f.clock()).wallMs })
      .where(eq(publicationRequests.id, next.requestId))).rejects.toThrow();
  });
});
