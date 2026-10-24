import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSandboxCallbackBridgeEnv,
  createFileSystemSandboxCallbackBridgeQueueClient,
  getSandboxCallbackBridgeServerSource,
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
  type SandboxCallbackBridgeQueueClient,
} from "./sandbox-callback-bridge.js";
import { sandboxCallbackQueueLifecycleSource } from "./sandbox-callback-queue-lifecycle.js";
import { sandboxCallbackQueuePolicy, SANDBOX_CALLBACK_QUEUE_V2_ENV } from "./sandbox-callback-queue-policy.js";

type Lifecycle = {
  publish(id: string, payload: Record<string, unknown>): Promise<number>;
  acknowledge(id: string): Promise<void>;
  expire(id: string): Promise<void>;
  sweep(): Promise<void>;
};
const createLifecycle = new Function(`return (${sandboxCallbackQueueLifecycleSource()})`)() as (input: {
  fs: typeof fs;
  path: typeof path;
  requestsDir: string;
  responseTimeoutMs: number;
  maxEnvelopeBytes: number;
}) => Lifecycle;

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "true"));
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-callback-queue-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Local bridge fixture did not reach the required state.");
}

describe("callback queue lifecycle", () => {
  it("publishes a complete immutable request before a reader or cleanup can see it", async () => {
    const requestsDir = await temporaryDirectory();
    const renameStarted = deferred();
    const allowRename = deferred();
    const lifecycle = createLifecycle({
      fs: { ...fs, rename: async (from, to) => {
        renameStarted.resolve();
        await allowRename.promise;
        return fs.rename(from, to);
      } },
      path, requestsDir, responseTimeoutMs: 60_000, maxEnvelopeBytes: 100_000,
    });
    const publishing = lifecycle.publish("atomic", { id: "atomic", body: "complete" });
    await renameStarted.promise;
    await lifecycle.sweep();
    expect((await fs.readdir(requestsDir)).filter(name => name.endsWith(".json"))).toEqual([]);
    allowRename.resolve();
    await publishing;
    expect(JSON.parse(await fs.readFile(path.join(requestsDir, "atomic.json"), "utf8")))
      .toMatchObject({ id: "atomic", body: "complete", expiresAt: expect.any(Number) });
  });

  it("preserves a pending request while its reader races cleanup, despite an old mtime", async () => {
    const requestsDir = await temporaryDirectory();
    const lifecycle = createLifecycle({ fs, path, requestsDir, responseTimeoutMs: 60_000, maxEnvelopeBytes: 100_000 });
    await lifecycle.publish("pending", { id: "pending", body: "saved" });
    const request = path.join(requestsDir, "pending.json");
    const old = new Date(Date.now() - 3600_000);
    await fs.utimes(request, old, old);
    const reader = await fs.open(request, "r");
    try {
      await Promise.all([lifecycle.sweep(), lifecycle.expire("pending")]);
      await expect(fs.stat(request)).resolves.toBeDefined();
      expect(JSON.parse(await reader.readFile("utf8"))).toMatchObject({ id: "pending", body: "saved" });
    } finally { await reader.close(); }
  });

  it("removes acknowledged and expired entries but preserves unexpired entries", async () => {
    const requestsDir = await temporaryDirectory();
    const lifecycle = createLifecycle({ fs, path, requestsDir, responseTimeoutMs: 60_000, maxEnvelopeBytes: 100_000 });
    await lifecycle.publish("pending", { id: "pending" });
    await lifecycle.publish("acknowledged", { id: "acknowledged" });
    await fs.writeFile(path.join(requestsDir, "expired.json"), JSON.stringify({ expiresAt: Date.now() - 1 }));
    await fs.writeFile(path.join(requestsDir, "orphan.json.acked"), "{}");
    await lifecycle.acknowledge("acknowledged");
    await lifecycle.sweep();
    expect(await fs.readdir(requestsDir)).toEqual(["pending.json"]);
  });

  it("cleans an expired legacy entry using its age", async () => {
    const requestsDir = await temporaryDirectory();
    const request = path.join(requestsDir, "legacy.json");
    await fs.writeFile(request, "{}");
    const old = new Date(Date.now() - 3600_000);
    await fs.utimes(request, old, old);
    await createLifecycle({ fs, path, requestsDir, responseTimeoutMs: 60_000, maxEnvelopeBytes: 100_000 }).sweep();
    expect(await fs.readdir(requestsDir)).toEqual([]);
  });
});

describe("callback queue deadlines", () => {
  it("uses nested default deadlines and forwards the rollback switch to the sandbox", () => {
    expect(sandboxCallbackQueuePolicy({}).enabled).toBe(true);
    vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "true");
    expect(sandboxCallbackQueuePolicy()).toMatchObject({
      enabled: true, controlTimeoutMs: 30_000, requestTimeoutMs: 90_000,
      watchdogTimeoutMs: 100_000, responseTimeoutMs: 120_000,
    });
    expect(buildSandboxCallbackBridgeEnv({ queueDir: "/queue", bridgeToken: "test" }))
      .toMatchObject({ PAPERCLIP_SANDBOX_CALLBACK_QUEUE_V2_ENABLED: "true", PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: "120000" });
    vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "false");
    expect(sandboxCallbackQueuePolicy()).toMatchObject({
      enabled: false, controlTimeoutMs: 10_000, requestTimeoutMs: 10_000,
      watchdogTimeoutMs: 20_000, responseTimeoutMs: 30_000,
    });
    expect(buildSandboxCallbackBridgeEnv({ queueDir: "/queue", bridgeToken: "test" }))
      .toMatchObject({ PAPERCLIP_SANDBOX_CALLBACK_QUEUE_V2_ENABLED: "false", PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: "30000" });
  });

  it.each(["handler", "list"])("does not abandon a live %s after 10 seconds", async stage => {
    vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "true");
    const waiting = deferred();
    const release = deferred();
    const received = deferred<number>();
    let exists = true;
    let calls = 0;
    let signal: AbortSignal | undefined;
    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {}, makeDirs: async () => {},
      listJsonFiles: async () => {
        if (stage === "list" && calls === 0) {
          calls++;
          waiting.resolve();
          await release.promise;
        }
        return exists ? ["slow.json"] : [];
      },
      readTextFile: async () => JSON.stringify({ id: "slow", method: "GET", path: "/api/agents/me", body: "" }),
      writeTextFile: async () => {}, rename: async () => {},
      writeResponseFile: async (_file, body) => { received.resolve(JSON.parse(body).status); return { wrote: true }; },
      remove: async () => { exists = false; },
    };
    vi.useFakeTimers();
    const worker = await startSandboxCallbackBridgeWorker({
      client, queueDir: "/virtual-queue", authorizeRequest: () => null,
      handleRequest: async (_request, options) => {
        signal = options?.signal;
        if (stage === "handler") { waiting.resolve(); await release.promise; }
        return { status: 200, body: "complete" };
      },
    });
    cleanups.push(() => worker.stop({ drainTimeoutMs: 50 }));
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(signal?.aborted ?? false).toBe(false);
    release.resolve();
    vi.useRealTimers();
    await expect(received.promise).resolves.toBe(200);
  });

  it("does not dispatch an expired request to the API handler", async () => {
    vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "true");
    const queueDir = await temporaryDirectory();
    const dirs = sandboxCallbackBridgeDirectories(queueDir);
    await fs.mkdir(dirs.requestsDir, { recursive: true });
    await fs.writeFile(path.join(dirs.requestsDir, "expired.json"), JSON.stringify({
      id: "expired", method: "POST", path: "/api/issues/one/comments", body: "{}", expiresAt: Date.now() - 1,
    }));
    const handleRequest = vi.fn(async () => ({ status: 200 }));
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(), queueDir, handleRequest,
    });
    cleanups.push(() => worker.stop({ drainTimeoutMs: 50 }));
    const response = path.join(dirs.responsesDir, "expired.json");
    await until(() => fs.readFile(response, "utf8").catch(() => ""), Boolean);
    expect(JSON.parse(await fs.readFile(response, "utf8")).status).toBe(503);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("checks expiry again after a delayed authorization", async () => {
    const queueDir = await temporaryDirectory();
    const dirs = sandboxCallbackBridgeDirectories(queueDir);
    await fs.mkdir(dirs.requestsDir, { recursive: true });
    const expiresAt = Date.now() + 10_000;
    await fs.writeFile(path.join(dirs.requestsDir, "queued.json"), JSON.stringify({
      id: "queued", method: "POST", path: "/api/issues/one/comments", body: "{}", expiresAt,
    }));
    const authorization = deferred();
    const release = deferred();
    const handleRequest = vi.fn(async () => ({ status: 200 }));
    const worker = await startSandboxCallbackBridgeWorker({
      client: createFileSystemSandboxCallbackBridgeQueueClient(), queueDir, handleRequest,
      authorizeRequest: async () => { authorization.resolve(); await release.promise; return null; },
    });
    cleanups.push(() => worker.stop({ drainTimeoutMs: 50 }));
    await authorization.promise;
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    release.resolve();
    const response = path.join(dirs.responsesDir, "queued.json");
    await until(() => fs.readFile(response, "utf8").catch(() => ""), Boolean);
    clock.mockRestore();
    expect(handleRequest).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(response, "utf8")).status).toBe(503);
  });
});

async function gateway(extraEnv: Record<string, string> = {}) {
  const root = await temporaryDirectory();
  const script = path.join(root, "gateway.mjs");
  const queueDir = path.join(root, "queue");
  const dirs = sandboxCallbackBridgeDirectories(queueDir);
  await fs.writeFile(script, getSandboxCallbackBridgeServerSource());
  const child: ChildProcess = spawn(process.execPath, [script], {
    env: { ...process.env, ...buildSandboxCallbackBridgeEnv({ queueDir, bridgeToken: "local-test", pollIntervalMs: 10 }),
      [SANDBOX_CALLBACK_QUEUE_V2_ENV]: "true", ...extraEnv }, stdio: "ignore",
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await exit;
    clearTimeout(timer);
  });
  const ready = await until(() => fs.readFile(dirs.readyFile, "utf8").catch(() => ""), Boolean);
  const { baseUrl } = JSON.parse(ready) as { baseUrl: string };
  return { dirs, queueDir, fetch: () => fetch(`${baseUrl}/api/agents/me`, { headers: { authorization: "Bearer local-test" } }) };
}

describe("generated callback gateway", () => {
  it("keeps a listed request through cleanup and acknowledges the response before removing it", async () => {
    const fixture = await gateway({ PAPERCLIP_BRIDGE_MAX_QUEUE_DEPTH: "1" });
    const first = fixture.fetch();
    const [file] = await until(() => fs.readdir(fixture.dirs.requestsDir), entries => entries.some(name => name.endsWith(".json")));
    const requestPath = path.join(fixture.dirs.requestsDir, file);
    const old = new Date(Date.now() - 3600_000);
    await fs.utimes(requestPath, old, old);
    // Capacity cleanup must retain the unexpired request, although its mtime is old.
    expect((await fixture.fetch()).status).toBe(503);
    const readStarted = deferred();
    const allowRead = deferred();
    const baseClient = createFileSystemSandboxCallbackBridgeQueueClient();
    const handleRequest = vi.fn(async () => ({ status: 200, body: "complete" }));
    const worker = await startSandboxCallbackBridgeWorker({
      client: { ...baseClient, readTextFile: async (...args) => {
        readStarted.resolve();
        await allowRead.promise;
        return baseClient.readTextFile(...args);
      }, remove: async () => {} }, // Force the gateway to perform acknowledgement cleanup.
      queueDir: fixture.queueDir, handleRequest,
    });
    cleanups.push(() => worker.stop({ drainTimeoutMs: 50 }));
    await readStarted.promise;
    // The periodic janitor races a host reader without deleting pending work.
    await new Promise(resolve => setTimeout(resolve, 1100));
    await expect(fs.stat(requestPath)).resolves.toBeDefined();
    allowRead.resolve();
    const response = await first;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("complete");
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(fixture.dirs.requestsDir)).toEqual([]);
    expect(await fs.readdir(fixture.dirs.responsesDir)).toEqual([]);
  });

  it("cleans an expired request without waiting for a full queue", async () => {
    const fixture = await gateway({ PAPERCLIP_BRIDGE_RESPONSE_TIMEOUT_MS: "500" });
    const response = await fixture.fetch();
    expect(response.status).toBe(502);
    expect(await fs.readdir(fixture.dirs.requestsDir)).toEqual([]);
    const expired = path.join(fixture.dirs.requestsDir, "orphan.json");
    await fs.writeFile(expired, JSON.stringify({ expiresAt: Date.now() - 1 }));
    await until(() => fs.readdir(fixture.dirs.requestsDir), entries => entries.length === 0);
  });
});
