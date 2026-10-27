import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, assets, companies, createDb, heartbeatRuns, issueAttachments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { uploadReceiptService } from "../services/upload-receipts.js";
import { correlateUpload } from "../services/upload-correlation.js";
import { createStorageService } from "../storage/service.js";
import { Readable } from "node:stream";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("durable upload receipts", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const issueId = randomUUID();
  const runId = randomUUID();
  const agentId = randomUUID();
  const bytes = Buffer.from("original upload bytes");
  const objects = new Map<string, Buffer>();
  let calls = 0;
  const storage = createStorageService({
    id: "local_disk",
    async putObject(input) {
      calls += 1;
      objects.set(input.objectKey, input.body as Buffer);
    },
    async getObject(input) { return { stream: Readable.from([objects.get(input.objectKey)!]) }; },
    async headObject() { throw new Error("No probe permitted"); },
    async deleteObject() { throw new Error("No deletion permitted"); },
  });
  storage.bindingId = "exact-storage-binding";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-upload-receipts-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Receipt test", issuePrefix: "UR" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Upload recovery" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", contextSnapshot: { issueId } });
  }, 30_000);

  afterAll(async () => { await tempDb?.cleanup(); });

  async function upload(operationId = randomUUID()) {
    const service = uploadReceiptService(db);
    const stored = await storage.putFile({ companyId, namespace: `issues/${issueId}`, originalFilename: "manifest.gz",
      contentType: "application/gzip", body: bytes, preserveOnError: true,
      beforePut: service.beforePut({ companyId, issueId, operationId, runId, agentId,
        actorType: "agent", actorId: agentId, storage }),
    });
    return { stored, operationId, service };
  }

  it("retains exact binding before failed registration and verifies bytes after a new service opens", async () => {
    const { stored, operationId } = await upload();
    // No attachment row exists. A fresh service must recover only the recorded object.
    const service = uploadReceiptService(db);
    expect(await service.findReceipt(companyId, operationId)).toMatchObject({
      companyId, issueId, runId, operationId, objectKey: stored.objectKey, bindingId: storage.bindingId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(await correlateUpload({ companyId, issueId, authorized: true, storage, repository: service,
      query: { runId, operationId, objectKey: stored.objectKey, verifyBytes: "true" } })).toMatchObject({
      outcome: "verified_bytes", registration: "unresolved", actualByteSize: bytes.length,
    });
  });

  it("rejects identity reuse before a second storage write", async () => {
    const { operationId } = await upload();
    const previousCalls = calls;
    await expect(upload(operationId)).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(previousCalls);
  });

  it("does not expose a receipt to another company", async () => {
    const { operationId, service } = await upload();
    expect(await service.findReceipt(randomUUID(), operationId)).toBeNull();
    expect(await service.runBelongsToIssue(companyId, randomUUID(), runId)).toBe(false);
    expect(await service.runBelongsToIssue(randomUUID(), issueId, runId)).toBe(false);
    expect(await service.runBelongsToIssue(companyId, issueId, randomUUID())).toBe(false);
  });

  it.each(["agent", "issue", "company", "terminal", "board"])("rejects upload attribution to an unauthorized %s scope", async (mismatch) => {
    const operationId = randomUUID();
    const service = uploadReceiptService(db);
    const otherRunId = randomUUID();
    if (mismatch === "terminal") {
      await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId, invocationSource: "on_demand",
        triggerDetail: "manual", status: "succeeded", contextSnapshot: { issueId } });
    }
    const beforePut = service.beforePut({
      companyId: mismatch === "company" ? randomUUID() : companyId,
      issueId: mismatch === "issue" ? randomUUID() : issueId,
      agentId: mismatch === "agent" ? randomUUID() : agentId,
      actorType: mismatch === "board" ? "user" : "agent", actorId: agentId,
      runId: mismatch === "terminal" ? otherRunId : runId, operationId, storage,
    });
    const previousCalls = calls;
    await expect(storage.putFile({ companyId, namespace: `issues/${issueId}`, originalFilename: "manifest.gz",
      contentType: "application/gzip", body: bytes, beforePut, preserveOnError: true })).rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(previousCalls);
    expect(await service.findReceipt(companyId, operationId)).toBeNull();
  });

  it("recovers registration after a response loss without a replacement attachment", async () => {
    const { stored, operationId, service } = await upload();
    const [asset] = await db.insert(assets).values({ companyId, ...stored }).returning();
    const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId, assetId: asset.id, originatingRunId: runId }).returning();
    const receipt = (await service.findReceipt(companyId, operationId))!;
    expect(await service.findRegistration(receipt)).toBe(attachment.id);
    expect(await service.findRegistration({ ...receipt, runId: randomUUID() })).toBeNull();
    expect(await service.findRegistration({ ...receipt, issueId: randomUUID() })).toBeNull();
    expect(await service.findRegistration({ ...receipt, objectKey: `${companyId}/different-object` })).toBeNull();
  });

  it("does not interpret missing legacy receipts as absent operations", async () => {
    expect(await correlateUpload({ companyId, issueId, authorized: true, storage, repository: uploadReceiptService(db),
      query: { runId, operationId: randomUUID(), verifyBytes: "false" } })).toMatchObject({
      outcome: "incomplete_evidence", objectBinding: null, actualByteSize: null,
    });
    expect((await db.select().from(activityLog)).length).toBeGreaterThan(0);
  });

  it("records proved absence when the dispatch audit fails before the provider call", async () => {
    const operationId = randomUUID();
    const insert = db.insert.bind(db);
    let inserts = 0;
    const spy = vi.spyOn(db, "insert").mockImplementation(((table) => {
      inserts += 1;
      if (inserts === 2) return { values: () => Promise.reject(new Error("dispatch audit unavailable")) };
      return insert(table);
    }) as typeof db.insert);
    const previousCalls = calls;
    try {
      await expect(upload(operationId)).rejects.toThrow("dispatch audit unavailable");
    } finally { spy.mockRestore(); }
    expect(calls).toBe(previousCalls);
    expect(await correlateUpload({ companyId, issueId, authorized: true, storage, repository: uploadReceiptService(db),
      query: { runId, operationId, verifyBytes: "false" } })).toMatchObject({
      outcome: "operation_absent", registration: "not_started", actualByteSize: null,
    });
  });
});
