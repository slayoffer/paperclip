import { Worker } from "node:worker_threads";

// Use only Node built-ins here. The same worker runs from source and compiled packages.
const HASH_WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { openSync, readSync, closeSync } = require("node:fs");
const buffer = Buffer.allocUnsafe(64 * 1024);
parentPort.on("message", (filePath) => {
  try {
    const fd = openSync(filePath, "r");
    let hash;
    try {
      hash = createHash("sha256");
      let length;
      while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, length));
      }
    } finally { closeSync(fd); }
    parentPort.postMessage({ hash: hash.digest("hex") });
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, code: error.code } });
  }
});
`;

/** One sequential scan owns one worker and one fixed-size read buffer. */
export class WorkspaceFileHasher {
  private worker: Worker | null = null;
  private pending: { resolve: (hash: string) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  hash(filePath: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Workspace file hasher is already busy"));
    if (!this.worker) {
      this.worker = new Worker(HASH_WORKER_SOURCE, { eval: true, execArgv: [] });
      this.worker.on("message", (result: { hash: string; error?: { message: string; code?: string } }) => {
        const pending = this.pending;
        this.pending = null;
        if (result.error) pending?.reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else pending?.resolve(result.hash);
      });
      this.worker.on("error", (error) => this.fail(error));
      this.worker.on("exit", (code) => this.fail(new Error(`Workspace hash worker exited with code ${code}`)));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker!.postMessage(filePath);
    });
  }

  private fail(error: Error): void {
    this.failure = error;
    this.pending?.reject(error);
    this.pending = null;
  }

  async close(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
  }
}

export async function hashWorkspaceFile(filePath: string): Promise<string> {
  const hasher = new WorkspaceFileHasher();
  try { return await hasher.hash(filePath); }
  finally { await hasher.close(); }
}
