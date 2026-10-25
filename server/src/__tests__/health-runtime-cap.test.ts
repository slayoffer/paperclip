import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthRoutes } from "../routes/health.js";
import { getProcessRunningRunsCap } from "../services/instance-run-cap.js";
import * as runtimeCapSource from "../services/runtime-cap.js";

vi.mock("../dev-server-status.js", () => ({ readPersistedDevServerStatus: () => undefined }));
vi.mock("../services/native-runtime/native-restart-recovery.js", () => ({
  nativeRestartRecoverySummary: async () => ({}),
}));

const listeners: Server[] = [];

async function app(options: { authenticated?: boolean; db?: Db; peer?: string; warm?: boolean } = {}) {
  const server = express();
  server.set("trust proxy", true);
  server.use((req, _res, next) => {
    if (options.peer) Object.defineProperty(req.socket, "remoteAddress", { value: options.peer });
    next();
  });
  server.use("/api/health", healthRoutes(options.db, {
    deploymentMode: options.authenticated ? "authenticated" : "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: false,
    isWarmStandby: () => options.warm ?? false,
  }));
  // Some execution hosts expose IPv6 sockets without an IPv6 loopback route.
  const listener = createServer(server);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  listeners.push(listener);
  return listener;
}

beforeEach(() => vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "24"));
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform !== "linux")("local runtime cap health receipt", () => {
  it("returns the exact collector contract without authentication", async () => {
    const response = await request(await app({ authenticated: true })).get("/api/health?capNonce=probe-1");
    const stat = readFileSync("/proc/self/stat", "utf8");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.serverInfo).toBeUndefined();
    expect(response.body.runtimeCap).toEqual({
      schema: "paperclip.runtime-cap.v1", nonce: "probe-1", pid: process.pid,
      startTicks: Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]),
      cap: getProcessRunningRunsCap(), immutable: true,
    });
    expect(response.body.runtimeCap.cap).toBe(24);
  });

  it("keeps admission and receipts fixed across router recreation and environment changes", async () => {
    const first = await app();
    const initial = await request(first).get("/api/health?capNonce=before");
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "6");
    const second = await app();
    for (const server of [first, second]) {
      const response = await request(server).get("/api/health?capNonce=after");
      expect(response.status).toBe(200);
      expect(response.body.runtimeCap).toEqual({ ...initial.body.runtimeCap, nonce: "after" });
      expect(response.body.runtimeCap.cap).toBe(getProcessRunningRunsCap());
    }
  });

  it.each([false, true])("retains the receipt with a database, warm standby %s", async (warm) => {
    const db = { execute: vi.fn(async () => []) } as unknown as Db;
    const response = await request(await app({ db, warm })).get("/api/health?capNonce=db");
    expect(response.status).toBe(200);
    expect(response.body.runtimeCap.cap).toBe(24);
  });

  it("preserves database failure status with a valid receipt", async () => {
    const db = { execute: vi.fn(async () => { throw new Error("unreachable"); }) } as unknown as Db;
    const response = await request(await app({ db })).get("/api/health?capNonce=db-failure");
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("database_unreachable");
    expect(response.body.runtimeCap.cap).toBe(24);
  });

  it("omits the receipt from ordinary health", async () => {
    const response = await request(await app()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.runtimeCap).toBeUndefined();
  });

  it("returns no receipt when the runtime source fails", async () => {
    vi.spyOn(runtimeCapSource, "getRuntimeCap").mockImplementationOnce(() => { throw new Error("unavailable"); });
    const response = await request(await app()).get("/api/health?capNonce=unavailable");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "runtime_cap_unavailable" });
  });

  it.each(["", "x".repeat(129)])("rejects invalid nonce length", async (nonce) => {
    const response = await request(await app()).get("/api/health").query({ capNonce: nonce });
    expect(response.status).toBe(400);
    expect(response.body.runtimeCap).toBeUndefined();
  });

  it("rejects ambiguous nonces", async () => {
    const response = await request(await app()).get("/api/health?capNonce=a&capNonce=b");
    expect(response.status).toBe(400);
  });

  it.each(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"])(
    "rejects proxy probes with %s", async (header) => {
      const response = await request(await app()).get("/api/health?capNonce=proxy").set(header, "127.0.0.1");
      expect(response.status).toBe(403);
      expect(response.body.runtimeCap).toBeUndefined();
    },
  );

  it("rejects a remote peer even when the Host header claims localhost", async () => {
    const response = await request(await app({ peer: "192.0.2.10" }))
      .get("/api/health?capNonce=remote").set("Host", "localhost");
    expect(response.status).toBe(403);
    expect(response.body.runtimeCap).toBeUndefined();
  });
});
