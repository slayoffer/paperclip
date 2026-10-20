import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { createServer } from "node:http";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { registerIssueInteractionReads } from "../routes/issue-interaction-reads.js";

async function fixture() {
  const issue = { id: "issue-1", companyId: "company-1" };
  const service = {
    listForIssue: vi.fn().mockResolvedValue([]),
    getForIssue: vi.fn().mockResolvedValue(null),
  };
  const context = {
    getIssue: vi.fn(async (_req: Request, _res: Response) => issue),
    authorize: vi.fn(async (_req: Request, _res: Response, _issue: typeof issue) => true),
    service,
  };
  const app = express();
  registerIssueInteractionReads(app, context);
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status ?? 500).json({ error: "Evidence is unreadable" });
  });
  const http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve, reject) => {
    http.close((error) => error ? reject(error) : resolve());
  }));
  return { app: http, context, issue, service };
}

describe("interaction evidence read failures", () => {
  it.each(["", "/card-1"])("fails closed when saved evidence is unreadable: %s", async (suffix) => {
    const { app, service } = await fixture();
    const failure = new Error("Database unavailable");
    service.listForIssue.mockRejectedValue(failure);
    service.getForIssue.mockRejectedValue(failure);
    const response = await request(app).get(`/issues/issue-1/interactions${suffix}`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Evidence is unreadable" });
    expect(response.body).not.toHaveProperty("status", "accepted");
  });

  it.each(["", "/card-1"])("does not read evidence after an issue access denial: %s", async (suffix) => {
    const { app, context, service } = await fixture();
    context.authorize.mockImplementationOnce(async (_req, res) => {
      res.status(403).json({ error: "Issue access denied" });
      return false;
    });
    await request(app).get(`/issues/issue-1/interactions${suffix}`).expect(403);
    expect(service.listForIssue).not.toHaveBeenCalled();
    expect(service.getForIssue).not.toHaveBeenCalled();
  });

  it("filters inconsistent company and issue rows from list evidence", async () => {
    const { app, service } = await fixture();
    service.listForIssue.mockResolvedValue([
      { id: "correct", companyId: "company-1", issueId: "issue-1", status: "pending" },
      { id: "foreign-company", companyId: "company-2", issueId: "issue-1", status: "accepted" },
      { id: "foreign-issue", companyId: "company-1", issueId: "issue-2", status: "accepted" },
    ]);
    const response = await request(app).get("/issues/issue-1/interactions").expect(200);
    expect(response.body.map((row: { id: string }) => row.id)).toEqual(["correct"]);
  });
});
