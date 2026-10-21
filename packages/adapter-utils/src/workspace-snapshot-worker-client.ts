import { Worker } from "node:worker_threads";
import type { WorkspacePaths, PathManifest } from "./workspace-manifest.js";
import type { SnapshotEntry } from "./workspace-restore-merge.js";

export interface WorkspaceSnapshotScanInput {
  rootDir: string;
  exclude: string[];
  ignoredPaths?: WorkspacePaths;
  manifestDirectory?: string;
}

// Source checkouts use Node's TypeScript support. Published packages load JavaScript.
// Resolve relative .js imports to .ts only when the JavaScript module is absent.
const BOOTSTRAP = String.raw`
const { workerData } = require("node:worker_threads");
if (workerData.source) {
  require("node:module").registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && specifier.endsWith(".js")) {
          return nextResolve(specifier.slice(0, -3) + ".ts", context);
        }
        throw error;
      }
    }
  });
}
import(workerData.moduleUrl).catch((error) => { throw error; });
`;

export async function scanWorkspaceSnapshot(input: WorkspaceSnapshotScanInput): Promise<PathManifest | Map<string, SnapshotEntry>> {
  const source = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(source ? "./workspace-snapshot-worker.ts" : "./workspace-snapshot-worker.js", import.meta.url).href;
  return new Promise((resolve, reject) => {
    const memory = new Map<string, SnapshotEntry>();
    let result: PathManifest | Map<string, SnapshotEntry> | undefined;
    let failure: Error | undefined;
    const worker = new Worker(BOOTSTRAP, { eval: true, execArgv: ["--disable-warning=ExperimentalWarning"], workerData: { input, source, moduleUrl } });
    worker.on("message", (message: { batch?: Array<[string, SnapshotEntry]>; manifest?: PathManifest; error?: { message: string; code?: string } }) => {
      if (message.batch) {
        for (const [relative, entry] of message.batch) memory.set(relative, entry);
        // Give timers and API callbacks a turn before admitting the next batch.
        setImmediate(() => worker.postMessage("continue"));
      } else if (message.error) failure = Object.assign(new Error(message.error.message), { code: message.error.code });
      else result = message.manifest ?? memory;
    });
    worker.on("error", (error) => { failure = error; });
    // Wait for exit before publishing or removing a manifest directory.
    worker.on("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Workspace snapshot worker exited with code ${code}`));
      else resolve(result);
    });
  });
}
