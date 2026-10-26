import { createServer } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import { startTime } from "pino-http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

async function loggedRequest(path: string, elapsed: number, status = 200) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); },
  });
  const app = express();
  app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  app.use((_req, res) => {
    res[startTime] = Date.now() - elapsed;
    res.status(status).end();
  });
  const server = createServer(app);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    await request(`http://127.0.0.1:${address.port}`).get(path);
    return chunks.join("");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe("slow HTTP requests", () => {
  it.each([200, 304])("logs slow polling responses with status %s", async (status) => {
    const output = await loggedRequest("/api/companies/company/issues?secret=private-canary", 2100, status);
    const log = JSON.parse(output.trim());
    expect(log.level).toBe(40);
    expect(log.req.method).toBe("GET");
    expect(log.req.url).toBe("/api/companies/company/issues");
    expect(log.responseTime).toBeGreaterThan(2000);
    expect(log.msg).toMatch(/GET .* slow request \(\d+ ms\)/);
    expect(output).not.toContain("private-canary");
  });

  it("keeps fast polling silent", async () => {
    expect(await loggedRequest("/api/companies/company/issues", 100)).toBe("");
  });

  it("preserves error severity for slow failures", async () => {
    expect(JSON.parse((await loggedRequest("/api/health", 2100, 503)).trim()).level).toBe(50);
  });

  it("keeps private callback routes content-free when slow", async () => {
    const output = await loggedRequest("/api/routine-triggers/public/private-canary/fire?token=private-canary", 2100);
    const log = JSON.parse(output.trim());
    expect(log.msg).toContain("/api/routine-triggers/public/:publicId/fire");
    expect(log.msg).toContain("slow request");
    expect(output).not.toContain("private-canary");
    expect(log.req.headers).toBeUndefined();
  });
});
