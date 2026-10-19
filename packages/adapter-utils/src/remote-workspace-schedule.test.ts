import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("./ssh.js", () => ({ ...mocks, runSshCommand: vi.fn() }));
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  mocks.prepareWorkspaceForSshExecution.mockResolvedValue({ gitBacked: false });
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function input() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-queue-"));
  directories.push(root);
  return {
    spec: { host: "localhost", port: 22, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
      privateKey: null, knownHosts: null, strictHostKeyChecking: true },
    runId: "test", adapterKey: "test", workspaceLocalDir: root,
  };
}

it("shares two slots between concurrent preparations and restores", async () => {
  const options = await input();
  let active = 0;
  let peak = 0;
  let operations = 0;
  const work = async () => {
    active++;
    peak = Math.max(peak, active);
    operations++;
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  };
  const prepared = await prepareRemoteManagedRuntime({ ...options, syncWorkspace: false,
    assets: [{ key: "home", localDir: options.workspaceLocalDir, restore: work }] });
  mocks.syncDirectoryToSsh.mockImplementation(work);
  await Promise.all(Array.from({ length: 24 }, (_, i) => i % 2 === 0
    ? prepareRemoteManagedRuntime({ ...options, runId: String(i), syncWorkspace: false,
      assets: [{ key: "home", localDir: options.workspaceLocalDir }] })
    : prepared.restoreWorkspace()));
  expect(peak).toBe(2);
  expect(operations).toBe(24);
});

it("logs baseline and asset timings before the agent starts", async () => {
  const options = await input();
  const lines: string[] = [];
  await prepareRemoteManagedRuntime({ ...options,
    onProgress: (line) => { lines.push(line); },
    assets: [{ key: "home", localDir: options.workspaceLocalDir }],
  });
  const log = lines.join("");
  expect(log).toMatch(/SSH workspace prepare admitted after \d+ ms/);
  expect(log).toMatch(/Workspace baseline completed in \d+ ms/);
  expect(log).toMatch(/Asset home sync completed in \d+ ms/);
  expect(log.indexOf("Workspace baseline started")).toBeLessThan(log.indexOf("Asset home sync started"));
});

it("releases the preparation slot after asset failure recovery", async () => {
  const options = await input();
  const failure = new Error("asset failed");
  mocks.syncDirectoryToSsh.mockRejectedValueOnce(failure);
  await expect(prepareRemoteManagedRuntime({ ...options,
    assets: [{ key: "home", localDir: options.workspaceLocalDir }],
  })).rejects.toBe(failure);
  expect(mocks.restoreWorkspaceFromSshExecution).toHaveBeenCalledOnce();
  await expect(prepareRemoteManagedRuntime(options)).resolves.toBeDefined();
});
