import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { acquireSshInPlaceWorktreeLock, releaseSshInPlaceWorktreeLocksForLease } from "../services/ssh-in-place-lock.ts";

const execFileAsync = promisify(execFile);
const moduleUrl = pathToFileURL(fileURLToPath(new URL("../services/ssh-in-place-lock.ts", import.meta.url))).href;
const roots: string[] = [];
const writers: number[] = [];
const leases: string[] = [];

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  for (const pid of writers.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGTERM");
  for (const lease of leases.splice(0)) releaseSshInPlaceWorktreeLocksForLease(lease);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("retains a crashed controller's durable lock while its previous writer remains alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "in-place-restart-"));
  roots.push(root);
  const key = path.join(root, "worktree");
  const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const writerExit = once(writer, "exit");
  const pid = writer.pid!;
  writers.push(pid);
  const source = `
    import { acquireSshInPlaceWorktreeLock } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await acquireSshInPlaceWorktreeLock({
      key: ${JSON.stringify(key)}, leaseId: 'old', runId: 'old-run', waitMs: 0,
      isHolderActive: async () => true,
    })));
  `;
  const first = await execFileAsync(process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source]);
  expect(JSON.parse(first.stdout)).toEqual({ acquired: true });
  // The server process exited. The remote writer did not exit.
  expect(isAlive(pid)).toBe(true);
  const input = {
    key, leaseId: "replacement", runId: "new-run", waitMs: 0,
    isHolderActive: async () => false,
    isHolderStopped: async () => !isAlive(pid),
  };
  leases.push(input.leaseId);
  expect(await acquireSshInPlaceWorktreeLock(input)).toMatchObject({
    acquired: false, holder: { leaseId: "old" },
  });
  // Another server cannot re-enter the old lease either.
  expect(await acquireSshInPlaceWorktreeLock({ ...input, leaseId: "old" }))
    .toMatchObject({ acquired: false });
  writer.kill("SIGTERM");
  await writerExit;
  expect(await acquireSshInPlaceWorktreeLock(input)).toEqual({ acquired: true });
});

it("refuses stale ownership transfer without positive termination evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "in-place-stale-"));
  roots.push(root);
  const key = path.join(root, "worktree");
  const first = { key, leaseId: "first", runId: "first-run", waitMs: 0, isHolderActive: async () => false };
  leases.push("first", "second");
  expect(await acquireSshInPlaceWorktreeLock(first)).toEqual({ acquired: true });
  expect(await acquireSshInPlaceWorktreeLock({ ...first, leaseId: "second" }))
    .toMatchObject({ acquired: false });
});
