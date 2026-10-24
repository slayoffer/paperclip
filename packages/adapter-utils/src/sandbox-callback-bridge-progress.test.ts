import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sandboxCallbackBridgeDirectories,
  startSandboxCallbackBridgeWorker,
  type SandboxCallbackBridgeQueueClient,
  type SandboxCallbackBridgeResponse,
} from "./sandbox-callback-bridge.js";
import { withBridgeProgressTimeout } from "./bridge-progress-timeout.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fixture() {
  const queueDir = "/synthetic-callback/queue";
  const dirs = sandboxCallbackBridgeDirectories(queueDir);
  const first = `${dirs.requestsDir}/a-read.json`;
  const second = `${dirs.requestsDir}/b-write.json`;
  const request = (id: string, method: string) => JSON.stringify({
    id, method, path: "/api/issues/synthetic", query: "", headers: {}, body: "",
    createdAt: new Date().toISOString(),
  });
  const requests = new Map([
    [first, request("a-read", "GET")],
    [second, request("b-write", "PATCH")],
  ]);
  const responses: SandboxCallbackBridgeResponse[] = [];
  const handlers: string[] = [];
  const errors: string[] = [];
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {},
    listJsonFiles: async () => [...requests.keys()].map((name) => name.split("/").at(-1)!),
    fileSize: async (name) => Buffer.byteLength(requests.get(name) ?? ""),
    readTextFile: async (name) => {
      const value = requests.get(name);
      if (value === undefined) throw new Error("missing synthetic request");
      return value;
    },
    writeTextFile: async () => {},
    rename: async () => {},
    writeResponseFile: async (_name, body) => {
      responses.push(JSON.parse(body));
      return { wrote: true };
    },
    remove: async (name) => { requests.delete(name); },
  };
  const start = (watchdogTimeoutMs = 10_000, authorizeRequest = async () => null as string | null, handlerDelayMs = 0) =>
    startSandboxCallbackBridgeWorker({
      client, queueDir, pollIntervalMs: 5, iterationTimeoutMs: 100,
      watchdogTimeoutMs, abortedHandlerGraceMs: 20, authorizeRequest,
      handleRequest: async (req) => {
        handlers.push(req.id);
        if (handlerDelayMs) await delay(handlerDelayMs);
        return { status: 200, body: "synthetic result" };
      },
      runtimeSpan: async (name, work) => {
        try { return await work(); }
        catch (error) {
          if (name === "sandbox.callbackBridge.workerFailed") errors.push(String(error));
          throw error;
        }
      },
    });
  return { client, start, first, second, requests, responses, handlers, errors };
}

async function stop(worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>>) {
  const stopped = worker.stop({ drainTimeoutMs: 1 });
  await vi.advanceTimersByTimeAsync(10);
  await stopped;
}

afterEach(() => { vi.useRealTimers(); });

describe("callback request progress", () => {
  it.each([10_000, 150])("serves a queued mutation after slow completed stages with watchdog %i", async (watchdog) => {
    vi.useFakeTimers();
    const f = fixture();
    const base = { ...f.client };
    f.client.fileSize = async (name) => { await delay(60); return base.fileSize!(name); };
    f.client.readTextFile = async (name) => { await delay(60); return base.readTextFile(name); };
    f.client.writeResponseFile = async (name, body, options) => {
      await delay(60);
      return base.writeResponseFile!(name, body, options);
    };
    f.client.remove = async (name) => { await delay(60); await base.remove(name); };
    const worker = await f.start(watchdog, async () => { await delay(60); return null; }, 60);
    try {
      await vi.advanceTimersByTimeAsync(800);
      expect(f.responses.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "a-read", status: 200 }, { id: "b-write", status: 200 },
      ]);
      expect(f.handlers).toEqual(["a-read", "b-write"]);
      expect(f.errors).toEqual([]);
      expect(f.requests.size).toBe(0);
    } finally { await stop(worker); }
  });

  it("abandons a stalled read and prevents its late result from starting a mutation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = f.client.readTextFile;
    let release!: () => void;
    let calls = 0;
    f.client.readTextFile = async (name) => {
      if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return read(name);
    };
    const worker = await f.start();
    try {
      await vi.advanceTimersByTimeAsync(130);
      expect(f.responses.map((r) => r.status)).toEqual([503, 503]);
      expect(f.errors.some((e) => e.includes("timed out after 100ms"))).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(50);
      expect(f.handlers).toEqual([]);
      expect(f.responses).toHaveLength(2);
    } finally { await stop(worker); }
  });

  it("bounds stalled cleanup without delivering a competing response or repeating a mutation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const remove = f.client.remove;
    let release!: () => void;
    f.client.remove = async (name) => {
      if (name === f.first) await new Promise<void>((resolve) => { release = resolve; });
      await remove(name);
    };
    const worker = await f.start();
    try {
      await vi.advanceTimersByTimeAsync(130);
      expect(f.responses.map((r) => r.status)).toEqual([200, 503]);
      expect(f.handlers).toEqual(["a-read"]);
      expect(f.errors.some((e) => e.includes("timed out after 100ms"))).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(50);
      expect(f.responses).toHaveLength(2);
      expect(f.handlers).toEqual(["a-read"]);
    } finally { await stop(worker); }
  });
});

describe("progress timer lifetime", () => {
  it("keeps expiration final after late stage completion", async () => {
    vi.useFakeTimers();
    const progress = vi.fn();
    let release!: () => void;
    const work = withBridgeProgressTimeout(async (completeStage) => {
      await completeStage(new Promise<void>((resolve) => { release = resolve; }));
      return "late result";
    }, 100, "synthetic stage", progress);
    const rejected = expect(work).rejects.toThrow("timed out after 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(progress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer after a synchronous error", async () => {
    vi.useFakeTimers();
    await expect(withBridgeProgressTimeout(() => {
      throw new Error("synthetic failure");
    }, 100, "synthetic stage", vi.fn())).rejects.toThrow("synthetic failure");
    expect(vi.getTimerCount()).toBe(0);
  });
});
