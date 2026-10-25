import { createHash } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePaperclipInstanceRootForAdapter } from "./server-utils.js";
import {
  captureDirectorySnapshot,
  directorySnapshotSha256,
  disposeDirectorySnapshot,
  classifyWorkspaceRestoreFailure,
  describeWorkspaceRestoreFailure,
  mergeDirectoryWithBaseline,
  parseDirectorySnapshot,
  serializeDirectorySnapshot,
  withDirectoryMergeLock,
  WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
} from "./workspace-restore-merge.js";

describe("workspace restore merge", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  describe("instance-scoped directory merge lock", () => {
    // Points PAPERCLIP_HOME (and, where noted, PAPERCLIP_INSTANCE_ID) at a
    // temporary directory so the lock root never touches the real Paperclip
    // instance, then restores the previous values. Mirrors the save-and-restore
    // pattern in acpx-engine/execute.test.ts.
    let previousHome: string | undefined;
    let previousInstanceId: string | undefined;

    function useTempPaperclipHome(homeDir: string, instanceId: string): void {
      previousHome = process.env.PAPERCLIP_HOME;
      previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
      process.env.PAPERCLIP_HOME = homeDir;
      process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    }

    afterEach(() => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      previousHome = undefined;
      previousInstanceId = undefined;
    });

    it("classifies the real lock-timeout error by its stable code, never by the message text", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
      cleanupDirs.push(rootDir);
      const paperclipHome = path.join(rootDir, "paperclip-home");
      useTempPaperclipHome(paperclipHome, "test-instance");

      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir, { recursive: true });

      // Pre-create the lock directory a live process holds, so `isLockStale`
      // never reports it stale and the retry loop can only leave through the
      // deadline check. The owner pid is this test process, which stays alive.
      const canonicalTargetDir = await realpath(targetDir);
      const lockKey = createHash("sha256").update(canonicalTargetDir).digest("hex");
      const lockRootDir = path.join(paperclipHome, "instances", "test-instance", "locks", "directory-merge");
      const heldLockDir = path.join(lockRootDir, `${lockKey}.lock`);
      await mkdir(heldLockDir, { recursive: true });
      await writeFile(
        path.join(heldLockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );

      // Reach the real deadline without a real 30-second wait: the first
      // `Date.now()` call computes the deadline (unchanged), and every call
      // after reports a time far past it, so the retry loop's own deadline
      // check — not a mocked message or a shortened constant — throws.
      const realNow = Date.now();
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockImplementationOnce(() => realNow)
        .mockImplementation(() => Number.MAX_SAFE_INTEGER);
      let caughtError: NodeJS.ErrnoException | undefined;
      try {
        await withDirectoryMergeLock(targetDir, async () => undefined);
      } catch (error) {
        caughtError = error as NodeJS.ErrnoException;
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError?.code).toBe(WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE);
      // The classifier reads only `code`; prove the message text carries no
      // trace of the classified outcome, so a message-text match could not
      // have produced this result.
      expect(caughtError?.message).not.toContain("restore_lock_timeout");
      expect(classifyWorkspaceRestoreFailure(caughtError)).toBe("restore_lock_timeout");
      expect(caughtError).toMatchObject({ workspaceRestoreLock: {
        ownerState: "alive", ownerSameProcess: true, knownLocalHolder: false,
      } });
    });

    it("reports a known live holder without releasing it when a contender times out", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-holder-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockRoot = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge");
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 900_001);
        try {
          await expect(withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
              knownLocalHolder: true, ownerPredatesProcess: false, operation: "agent_directory_release" },
          });
        } finally { clock.mockRestore(); }
        expect(contender).not.toHaveBeenCalled();
        expect((await readdir(lockRoot)).filter((name) => name.endsWith(".owner.json"))).toHaveLength(1);
      });
      expect(await readdir(lockRoot)).toEqual([expect.stringMatching(/\.lock\.sqlite$/)]);
    });

    it("delivers the timeout when the diagnostic owner read stalls and ignores its late rejection", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-stall-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 900_001);
        let markReadStarted!: (signal: AbortSignal) => void;
        const readStarted = new Promise<AbortSignal>((resolve) => { markReadStarted = resolve; });
        let rejectStalledRead!: (error: Error) => void;
        const stalledRead = new Promise<string>((_resolve, reject) => { rejectStalledRead = reject; });
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation((file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            markReadStarted(options.signal);
            return stalledRead;
          });
        try {
          const pending = withDirectoryMergeLock(targetDir, contender, process.env, "agent_directory_release")
            .catch((error: unknown) => error);
          const signal = await readStarted;
          await vi.advanceTimersByTimeAsync(100);
          const error = await pending;
          expect(error).toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState: "unknown", knownLocalHolder: true,
              operation: "agent_directory_release" },
          });
          expect(signal.aborted).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
          rejectStalledRead(new Error("late filesystem failure"));
          await Promise.resolve();
          expect(contender).not.toHaveBeenCalled();
          expect(error).toMatchObject({ workspaceRestoreLock: { ownerState: "unknown" } });
        } finally {
          vi.useRealTimers();
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it.each([
      { label: "malformed JSON", raw: "{invalid-json", code: undefined, ownerState: "invalid" },
      { label: "a missing file", raw: undefined, code: "ENOENT", ownerState: "missing" },
      { label: "an unreadable file", raw: undefined, code: "EACCES", ownerState: "unknown" },
    ])("distinguishes $label in the diagnostic read", async ({ raw, code, ownerState }) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-read-state-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const contender = vi.fn();
      await withDirectoryMergeLock(targetDir, async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now)
          .mockReturnValueOnce(now).mockReturnValueOnce(now + 900_001);
        const realReadFile = fsPromises.readFile;
        const readSpy = vi.spyOn(fsPromises, "readFile")
          .mockImplementation(async (file, options) => {
            if (!options || typeof options !== "object" || !options.signal) return realReadFile(file, options);
            if (code) throw Object.assign(new Error("owner read failed"), { code });
            return raw!;
          });
        try {
          await expect(withDirectoryMergeLock(targetDir, contender)).rejects.toMatchObject({
            code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
            workspaceRestoreLock: { ownerState, knownLocalHolder: true },
          });
          expect(contender).not.toHaveBeenCalled();
        } finally {
          readSpy.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it("reports an owner older than this process without reclaiming a live PID", async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-older-owner-"));
      cleanupDirs.push(rootDir);
      useTempPaperclipHome(path.join(rootDir, "home"), "test-instance");
      const targetDir = path.join(rootDir, "target");
      await mkdir(targetDir);
      const lockKey = createHash("sha256").update(await realpath(targetDir)).digest("hex");
      const lockDir = path.join(rootDir, "home", "instances", "test-instance", "locks", "directory-merge", `${lockKey}.lock`);
      await mkdir(lockDir, { recursive: true });
      const now = Date.now();
      const owner = JSON.stringify({ pid: process.pid, createdAt: new Date(now - process.uptime() * 1000 - 10_000).toISOString(), private: "private owner payload" });
      await writeFile(path.join(lockDir, "owner.json"), owner);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now)
        .mockReturnValueOnce(now).mockReturnValueOnce(now + 900_001);
      let caught: unknown;
      try { await withDirectoryMergeLock(targetDir, async () => { throw new Error("must not acquire"); }); }
      catch (error) { caught = error; }
      finally { clock.mockRestore(); }
      expect(caught).toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
        workspaceRestoreLock: { ownerState: "alive", ownerSameProcess: true,
          knownLocalHolder: false, ownerPredatesProcess: true } });
      const diagnostic = (caught as { workspaceRestoreLock: Record<string, unknown> }).workspaceRestoreLock;
      expect(Object.keys(diagnostic).sort()).toEqual(["knownLocalHolder", "ownerAgeMs", "ownerPredatesProcess", "ownerSameProcess", "ownerState", "waitMs"]);
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain(lockDir);
      expect(await readFile(path.join(lockDir, "owner.json"), "utf8")).toBe(owner);
    });

    it.skipIf(process.platform === "win32")(
      "serializes two concurrent writers that address one target through different aliases",
      async () => {
        const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-restore-merge-"));
        cleanupDirs.push(rootDir);
        useTempPaperclipHome(path.join(rootDir, "paperclip-home"), "test-instance");

        const targetDir = path.join(rootDir, "target");
        const aliasDir = path.join(rootDir, "target-alias");
        await mkdir(targetDir, { recursive: true });
        await symlink(targetDir, aliasDir);

        let active = false;
        let overlapCount = 0;
        let completedCount = 0;
        const runWriter = (dir: string) =>
          withDirectoryMergeLock(dir, async () => {
            if (active) overlapCount += 1;
            active = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            active = false;
            completedCount += 1;
          });

        await Promise.all([runWriter(targetDir), runWriter(aliasDir)]);

        expect(overlapCount).toBe(0);
        expect(completedCount).toBe(2);
      },
    );
  });


});
