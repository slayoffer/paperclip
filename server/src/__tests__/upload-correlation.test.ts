import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { correlateUpload, type UploadReceipt } from "../services/upload-correlation.js";
import { createStorageService } from "../storage/service.js";
import { HttpError } from "../errors.js";

const bytes = Buffer.from("the complete compressed manifest");
const receipt: UploadReceipt = {
  companyId: "company-a", issueId: "issue-a", runId: "run-a", operationId: "operation-a",
  objectKey: "company-a/issues/issue-a/exact-object.gz", provider: "local_disk", bindingId: "binding-a",
  byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), notStarted: false,
};

function fixture() {
  const repository = {
    runBelongsToIssue: vi.fn(async () => true),
    findReceipt: vi.fn(async (): Promise<UploadReceipt | null> => ({ ...receipt })),
    findRegistration: vi.fn(async (): Promise<string | null> => null),
  };
  const storage = {
    provider: "local_disk" as const, bindingId: receipt.bindingId,
    getObject: vi.fn(async () => ({ stream: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]) })),
    putFile: vi.fn(), deleteObject: vi.fn(), headObject: vi.fn(),
  };
  const input = {
    companyId: receipt.companyId, issueId: receipt.issueId, authorized: true,
    query: { runId: receipt.runId!, operationId: receipt.operationId, objectKey: receipt.objectKey, verifyBytes: "true" as const },
    repository, storage,
  };
  return { input, repository, storage };
}

describe("bounded upload correlation", () => {
  it("verifies complete stored bytes after registration failed", async () => {
    const { input, storage } = fixture();
    expect(await correlateUpload(input)).toMatchObject({ outcome: "verified_bytes", registration: "unresolved",
      actualByteSize: bytes.length, actualSha256: receipt.sha256, attachmentId: null });
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it("finds registration when the original response was lost", async () => {
    const { input, repository } = fixture();
    repository.findRegistration.mockResolvedValue("attachment-a");
    expect(await correlateUpload(input)).toMatchObject({ outcome: "verified_bytes", registration: "registered", attachmentId: "attachment-a" });
  });

  it.each([false, true])("keeps missing legacy receipts unresolved with registration=%s", async (registered) => {
    const { input, repository, storage } = fixture();
    repository.findReceipt.mockResolvedValue(null);
    repository.findRegistration.mockResolvedValue(registered ? "attachment-a" : null);
    expect(await correlateUpload(input)).toMatchObject({ outcome: "incomplete_evidence", objectBinding: null, actualByteSize: null });
    expect(repository.findRegistration).not.toHaveBeenCalled();
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("does not invent a historical operation identity", async () => {
    const { input, repository } = fixture();
    const result = await correlateUpload({ ...input, query: { runId: receipt.runId!, verifyBytes: "false" } });
    expect(result).toMatchObject({ outcome: "incomplete_evidence", operationId: null, objectBinding: null });
    expect(repository.findReceipt).not.toHaveBeenCalled();
  });

  it("requires separate caller authority before repository reads", async () => {
    const { input, repository, storage } = fixture();
    expect(await correlateUpload({ ...input, authorized: false })).toMatchObject({ outcome: "access_denied" });
    expect(repository.runBelongsToIssue).not.toHaveBeenCalled();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("rejects an original run outside the issue", async () => {
    const { input, repository } = fixture();
    repository.runBelongsToIssue.mockResolvedValue(false);
    expect(await correlateUpload(input)).toMatchObject({ outcome: "access_denied", objectBinding: null });
    expect(repository.findReceipt).not.toHaveBeenCalled();
  });

  it.each([
    { companyId: "company-b" }, { issueId: "issue-b" }, { runId: "run-b" },
    { operationId: "operation-b" }, { objectKey: "company-a/issues/issue-a/other-object" },
    { objectKey: "company-a/issues/issue-b/object" },
  ])("rejects a mismatched receipt %j", async (override) => {
    const { input, repository, storage } = fixture();
    repository.findReceipt.mockResolvedValue({ ...receipt, ...override });
    expect(await correlateUpload(input)).toMatchObject({ outcome: "access_denied", objectBinding: null });
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("does not treat matching receipt metadata as byte proof", async () => {
    const { input, storage } = fixture();
    expect(await correlateUpload({ ...input, query: { ...input.query, verifyBytes: "false" } })).toMatchObject({
      outcome: "incomplete_evidence", expectedSha256: receipt.sha256, actualSha256: null,
    });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("requires an exact object key before byte comparison", async () => {
    const { input, storage } = fixture();
    expect(await correlateUpload({ ...input, query: { ...input.query, objectKey: undefined } })).toMatchObject({ outcome: "incomplete_evidence" });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("preserves an unresolved object when the storage binding changed", async () => {
    const { input, storage } = fixture();
    storage.bindingId = "another-bucket";
    expect(await correlateUpload(input)).toMatchObject({ outcome: "incomplete_evidence" });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])("reports storage status %s without claiming operation absence", async (status) => {
    const { input, storage } = fixture();
    storage.getObject.mockRejectedValue(new HttpError(status, "storage response"));
    expect(await correlateUpload(input)).toMatchObject({ outcome: status === 403 ? "access_denied" : "incomplete_evidence" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it.each([Buffer.from("wrong"), Buffer.alloc(bytes.length, 0), Buffer.alloc(bytes.length + 1)])("rejects incorrect complete bytes %j", async (body) => {
    const { input, storage } = fixture();
    storage.getObject.mockImplementation(async () => ({ stream: Readable.from([body]) }));
    expect(await correlateUpload(input)).toMatchObject({ outcome: "incomplete_evidence" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("does not treat a partial stream as complete hash evidence", async () => {
    const { input, storage } = fixture();
    storage.getObject.mockImplementation(async () => ({ stream: Readable.from((async function* () {
      yield bytes.subarray(0, 5);
      throw new Error("connection lost");
    })()) }));
    expect(await correlateUpload(input)).toMatchObject({ outcome: "incomplete_evidence", actualSha256: null, actualByteSize: null });
  });

  it("distinguishes a proved stop before dispatch from a missing receipt", async () => {
    const { input, repository, storage } = fixture();
    repository.findReceipt.mockResolvedValue({ ...receipt, notStarted: true });
    expect(await correlateUpload(input)).toMatchObject({ outcome: "operation_absent", registration: "not_started" });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("cancels a stalled stream at the comparison deadline", async () => {
    vi.useFakeTimers();
    try {
      const { input, storage } = fixture();
      const stream = new Readable({ read() {} });
      storage.getObject.mockImplementation(async () => ({ stream }));
      const pending = correlateUpload(input);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await pending).toMatchObject({ outcome: "incomplete_evidence", actualSha256: null });
      expect(stream.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("storage receipt ordering", () => {
  function providerFixture() {
    const objects = new Map<string, Buffer>();
    const provider = {
      id: "local_disk" as const,
      putObject: vi.fn(async (input) => { objects.set(input.objectKey, input.body); }),
      getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn(),
    };
    return { provider, objects, service: createStorageService(provider) };
  }

  it("persists the exact planned binding before storage receives bytes", async () => {
    const { service, provider } = providerFixture();
    const beforePut = vi.fn(async (planned) => {
      expect(provider.putObject).not.toHaveBeenCalled();
      expect(planned.sha256).toBe(receipt.sha256);
    });
    const stored = await service.putFile({ companyId: receipt.companyId, namespace: `issues/${receipt.issueId}`,
      originalFilename: "manifest.gz", contentType: "application/gzip", body: bytes, beforePut, preserveOnError: true });
    expect(beforePut).toHaveBeenCalledWith(stored);
    expect(provider.putObject.mock.calls[0][0].objectKey).toBe(stored.objectKey);
  });

  it("sends no bytes when receipt persistence fails", async () => {
    const { service, provider } = providerFixture();
    await expect(service.putFile({ companyId: receipt.companyId, namespace: "issues/issue-a", originalFilename: null,
      contentType: "application/gzip", body: bytes, preserveOnError: true,
      beforePut: async () => { throw new Error("database unavailable"); } })).rejects.toThrow("database unavailable");
    expect(provider.putObject).not.toHaveBeenCalled();
    expect(provider.deleteObject).not.toHaveBeenCalled();
  });

  it("preserves bytes when the provider response is lost", async () => {
    const { service, provider, objects } = providerFixture();
    provider.putObject.mockImplementation(async (input) => {
      objects.set(input.objectKey, input.body);
      throw new Error("response lost after storage");
    });
    await expect(service.putFile({ companyId: receipt.companyId, namespace: "issues/issue-a", originalFilename: null,
      contentType: "application/gzip", body: bytes, beforePut: async () => {}, preserveOnError: true })).rejects.toThrow("response lost");
    expect(objects.size).toBe(1);
    expect(provider.deleteObject).not.toHaveBeenCalled();
  });
});
