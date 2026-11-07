import { parentPort, workerData } from "node:worker_threads";
import { scanWorkspaceSnapshotFiles } from "./workspace-snapshot-scan.js";
import type { WorkspaceSnapshotScanInput } from "./workspace-snapshot-worker-client.js";

// Content reads, hashing, enumeration, and SQLite writes stay in this worker.
const input = workerData.input as WorkspaceSnapshotScanInput;
try {
  const result = await scanWorkspaceSnapshotFiles(input, async batch => {
    const acknowledgement = new Promise<void>(resolve => parentPort!.once("message", () => resolve()));
    parentPort!.postMessage({ batch });
    await acknowledgement;
  });
  parentPort!.postMessage(result);
} catch (error) {
  const failure = error as NodeJS.ErrnoException;
  parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
} finally { parentPort!.close(); }
