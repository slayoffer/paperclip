import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSandboxCallbackBridgeWorker, type SandboxCallbackBridgeQueueClient } from "./sandbox-callback-bridge.js";
import { sandboxCallbackQueueLifecycleSource } from "./sandbox-callback-queue-lifecycle.js";
import { SANDBOX_CALLBACK_QUEUE_V2_ENV } from "./sandbox-callback-queue-policy.js";

const cleanups: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.stubEnv(SANDBOX_CALLBACK_QUEUE_V2_ENV, "true"));
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function runVirtualRequest(options: { method: string; slowStages?: boolean; forwardTimeout?: boolean }) {
  vi.useFakeTimers();
  const receipt = deferred<{ status: number; headers: Record<string, string> }>();
  let pending = true;
  let firstList = true;
  let aborted = false;
  const raw = JSON.stringify({
    id: "request", method: options.method, path: "/api/agents/me", body: "", expiresAt: Date.now() + 30_000,
  });
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {}, makeDirs: async () => {},
    listJsonFiles: async () => {
      if (options.slowStages && firstList) { firstList = false; await sleep(4_000); }
      return pending ? ["request.json"] : [];
    },
    fileSize: async () => { if (options.slowStages) await sleep(4_000); return Buffer.byteLength(raw); },
    readTextFile: async () => { if (options.slowStages) await sleep(4_000); return raw; },
    writeTextFile: async () => {}, rename: async () => {}, remove: async () => { pending = false; },
    writeResponseFile: async (_target, body) => {
      receipt.resolve(JSON.parse(body));
      pending = false; // The virtual gateway consumes and acknowledges the receipt.
      return { wrote: true };
    },
  };
  const worker = await startSandboxCallbackBridgeWorker({
    client, queueDir: "/virtual-review", authorizeRequest: () => null,
    handleRequest: async (_request, context) => {
      context?.signal.addEventListener("abort", () => { aborted = true; });
      if (options.forwardTimeout) {
        await sleep(5_000);
        throw new DOMException("The API forward timed out before response headers.", "TimeoutError");
      }
      await sleep(4_000);
      return { status: 200, body: "complete" };
    },
  });
  cleanups.push(() => worker.stop({ drainTimeoutMs: 10 }));
  await vi.advanceTimersByTimeAsync(options.slowStages ? 16_100 : 6_000);
  const response = await receipt.promise;
  const stopping = worker.stop({ drainTimeoutMs: 10 });
  await vi.advanceTimersByTimeAsync(20);
  await stopping;
  return { response, aborted };
}

describe("callback review regressions", () => {
  it.each(["POST", "GET"])("classifies an independent forward timeout for %s", async method => {
    const { response, aborted } = await runVirtualRequest({ method, forwardTimeout: true });
    expect(aborted).toBe(false);
    expect(response.status).toBe(method === "POST" ? 504 : 502);
    expect(response.headers["x-paperclip-bridge-outcome"]).toBe(method === "POST" ? "indeterminate" : undefined);
  });

  it("finishes a live request after 10 seconds when every stage makes progress", async () => {
    const { response, aborted } = await runVirtualRequest({ method: "POST", slowStages: true });
    expect(aborted).toBe(false);
    expect(response.status).toBe(200);
  });

  it("shares concurrent cleanup and reads at most 128 metadata bytes from a large request", async () => {
    const requestsDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-queue-memory-"));
    cleanups.push(() => fs.rm(requestsDir, { recursive: true, force: true }));
    const reached = deferred();
    const release = deferred();
    let opens = 0;
    let largestRead = 0;
    const createLifecycle = new Function(`return (${sandboxCallbackQueueLifecycleSource()})`)() as (input: {
      fs: object; path: typeof path; requestsDir: string; responseTimeoutMs: number; maxEnvelopeBytes: number;
    }) => { publish(id: string, payload: object): Promise<number>; sweep(): Promise<void> };
    const lifecycle = createLifecycle({
      fs: { ...fs, readFile: () => { throw new Error("Cleanup must not read the whole body."); },
        open: async (file: string, flags: string) => {
          opens++;
          const handle = await fs.open(file, flags);
          return {
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
              largestRead = Math.max(largestRead, length);
              reached.resolve();
              await release.promise;
              return handle.read(buffer, offset, length, position);
            }, close: () => handle.close(),
          };
        },
      }, path, requestsDir, responseTimeoutMs: 60_000, maxEnvelopeBytes: 20_000_000,
    });
    await lifecycle.publish("large", { body: "x".repeat(1024 * 1024) });
    const old = new Date(Date.now() - 3600_000);
    await fs.utimes(path.join(requestsDir, "large.json"), old, old);
    const scans = Array.from({ length: 300 }, () => lifecycle.sweep());
    await reached.promise;
    expect(opens).toBe(1);
    release.resolve();
    await Promise.all(scans);
    expect(largestRead).toBe(128);
    expect(await fs.readdir(requestsDir)).toEqual(["large.json"]);
  });

  it("does not send a recovery 503 after a delayed recovery read overlaps handler ownership", async () => {
    vi.useFakeTimers();
    const readingSecond = deferred();
    const releaseRecoveryRead = deferred();
    const secondStarted = deferred();
    const receipts: Array<{ id: string; status: number }> = [];
    let secondReads = 0;
    const pending = new Set(["first.json", "second.json"]);
    const raw = (id: string) => JSON.stringify({
      id, method: "POST", path: "/api/issues/one/comments", body: "{}", expiresAt: Date.now() + 30_000,
    });
    const client: SandboxCallbackBridgeQueueClient = {
      makeDir: async () => {}, makeDirs: async () => {}, listJsonFiles: async () => [...pending],
      readTextFile: async target => {
        const id = path.posix.basename(target, ".json");
        if (id === "second" && ++secondReads === 1) {
          readingSecond.resolve();
          await releaseRecoveryRead.promise;
        }
        return raw(id);
      }, writeTextFile: async () => {}, rename: async () => {}, remove: async () => {},
      writeResponseFile: async (target, body) => {
        const response = JSON.parse(body) as { id: string; status: number };
        if (receipts.some(item => item.id === response.id)) return { wrote: false };
        receipts.push(response);
        pending.delete(path.posix.basename(target));
        return { wrote: true };
      },
    };
    const worker = await startSandboxCallbackBridgeWorker({
      client, queueDir: "/virtual-recovery-race", iterationTimeoutMs: 1000,
      requestTimeoutMs: 1000, watchdogTimeoutMs: 100, authorizeRequest: () => null,
      handleRequest: async (request, options) => {
        if (request.id === "second") secondStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          options!.signal.addEventListener("abort", () => reject(options!.signal.reason), { once: true });
        });
        return { status: 200 };
      },
    });
    cleanups.push(() => worker.stop({ drainTimeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(100);
    await readingSecond.promise;
    await secondStarted.promise;
    releaseRecoveryRead.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(receipts.map(({ id, status }) => ({ id, status })))
      .toEqual([{ id: "first", status: 504 }, { id: "second", status: 504 }]);
    const stopping = worker.stop({ drainTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    await stopping;
  });
});
