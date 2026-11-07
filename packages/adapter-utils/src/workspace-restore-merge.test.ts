import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withDirectoryMergeLock,
  withDirectoryPublicationLock,
  WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
} from "./workspace-restore-merge.js";
import "./workspace-restore-merge.behavior.cases.js";
import "./workspace-directory-lock-root.cases.js";
import "./workspace-directory-lock-diagnostics.cases.js";

describe("workspace publication locks", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("locks absent publications independently while sharing the published target's merge lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-publication-lock-"));
    cleanupDirs.push(root);
    const env = { PAPERCLIP_HOME: path.join(root, "home"), PAPERCLIP_INSTANCE_ID: "publication" };
    const first = path.join(root, "first"), second = path.join(root, "second");
    await withDirectoryPublicationLock(first, async canonical => {
      expect(await lstat(first).catch(() => null)).toBeNull();
      await mkdir(canonical);
      await withDirectoryPublicationLock(second, async other => {
        await mkdir(other);
        expect(other).not.toBe(canonical);
      }, env);
      const merge = vi.fn();
      await expect(withDirectoryMergeLock(first, merge, env, undefined, 30)).rejects.toMatchObject({
        code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE,
      });
      expect(merge).not.toHaveBeenCalled();
    }, env);
    await withDirectoryMergeLock(first, async canonical => expect(canonical).toBe(await realpath(first)), env);
  });

  it.skipIf(process.platform === "win32")("canonicalizes publication parents and rejects unsafe existing leaves", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-publication-alias-"));
    cleanupDirs.push(root);
    const env = { PAPERCLIP_HOME: path.join(root, "home"), PAPERCLIP_INSTANCE_ID: "publication" };
    const parent = path.join(root, "parent"), alias = path.join(root, "alias");
    await mkdir(parent); await symlink(parent, alias);
    await withDirectoryPublicationLock(path.join(alias, "child"), async canonical => {
      expect(canonical).toBe(path.join(await realpath(parent), "child"));
    }, env);
    await symlink(parent, path.join(parent, "child"));
    await expect(withDirectoryPublicationLock(path.join(alias, "child"), async () => undefined, env)).rejects.toThrow("not a plain directory");
    await rm(path.join(parent, "child")); await writeFile(path.join(parent, "child"), "occupied");
    await expect(withDirectoryPublicationLock(path.join(alias, "child"), async () => undefined, env)).rejects.toThrow("not a plain directory");
  });

});
