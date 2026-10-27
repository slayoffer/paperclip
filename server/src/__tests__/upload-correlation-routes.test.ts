import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerUploadCorrelation } from "../routes/upload-correlation.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({
  canUser: vi.fn(), runBelongsToIssue: vi.fn(), findReceipt: vi.fn(), findRegistration: vi.fn(),
}));
vi.mock("../services/access.js", () => ({ accessService: () => ({ canUser: mocks.canUser }) }));
vi.mock("../services/upload-receipts.js", () => ({ uploadReceiptService: () => mocks }));

const companyId = randomUUID();
const issueId = randomUUID();
const runId = randomUUID();
const operationId = randomUUID();
const endpoint = `/api/companies/${companyId}/issues/${issueId}/attachment-upload-correlation`;

function fixture(actorOverrides: Record<string, unknown> = {}, issueCompany = companyId) {
  const app = express();
  const storage = { provider: "local_disk" as const, putFile: vi.fn(), getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn() };
  const getIssue = vi.fn(async () => ({ id: issueId, companyId: issueCompany }));
  const authorize = vi.fn(async () => true);
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "operator", companyIds: [companyId], source: "session", ...actorOverrides } as typeof req.actor;
    next();
  });
  const router = express.Router();
  registerUploadCorrelation(router, { db: {} as never, storage, getIssue, authorize });
  app.use("/api", router);
  app.use(errorHandler);
  return { app, storage, getIssue, authorize };
}

describe("upload correlation access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUser.mockResolvedValue(true);
    mocks.runBelongsToIssue.mockResolvedValue(true);
    mocks.findReceipt.mockResolvedValue(null);
    mocks.findRegistration.mockResolvedValue(null);
  });

  it("requires separate board audit authority", async () => {
    mocks.canUser.mockResolvedValue(false);
    const { app, getIssue, storage } = fixture();
    const response = await request(app).get(endpoint).query({ runId, operationId });
    expect(response.status).toBe(403);
    expect(response.body.outcome).toBe("access_denied");
    expect(mocks.canUser).toHaveBeenCalledWith(companyId, "operator", "audit:view_agent_actions");
    expect(getIssue).not.toHaveBeenCalled();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("does not grant agents a new storage or run-log capability", async () => {
    const { app, getIssue } = fixture({ type: "agent", companyId, agentId: randomUUID() });
    expect((await request(app).get(endpoint).query({ runId })).status).toBe(403);
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("rejects a different company before evidence reads", async () => {
    const { app, getIssue } = fixture({ companyIds: [randomUUID()] });
    expect((await request(app).get(endpoint).query({ runId, operationId })).status).toBe(403);
    expect(getIssue).not.toHaveBeenCalled();
    expect(mocks.findReceipt).not.toHaveBeenCalled();
  });

  it("rejects an issue outside the company", async () => {
    const { app } = fixture({}, randomUUID());
    expect((await request(app).get(endpoint).query({ runId, operationId })).status).toBe(404);
    expect(mocks.findReceipt).not.toHaveBeenCalled();
  });

  it("retains existing issue visibility checks", async () => {
    const { app, authorize } = fixture();
    authorize.mockImplementation(async (_req, res) => { res.sendStatus(403); return false; });
    expect((await request(app).get(endpoint).query({ runId, operationId })).status).toBe(403);
    expect(mocks.runBelongsToIssue).not.toHaveBeenCalled();
  });

  it("rejects another original run", async () => {
    mocks.runBelongsToIssue.mockResolvedValue(false);
    const { app } = fixture();
    const response = await request(app).get(endpoint).query({ runId, operationId });
    expect(response.status).toBe(403);
    expect(response.body.outcome).toBe("access_denied");
    expect(mocks.findReceipt).not.toHaveBeenCalled();
  });

  it.each([{ operationId }, { runId: "invalid" }, { runId, arbitraryObject: "bucket/key" }])("rejects invalid scope %j", async (query) => {
    const { app } = fixture();
    expect((await request(app).get(endpoint).query(query)).status).toBe(400);
    expect(mocks.findReceipt).not.toHaveBeenCalled();
  });

  it("reports unknown legacy identity without storage access", async () => {
    const { app, storage } = fixture();
    const response = await request(app).get(endpoint).query({ runId });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ outcome: "incomplete_evidence", operationId: null, objectBinding: null });
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
