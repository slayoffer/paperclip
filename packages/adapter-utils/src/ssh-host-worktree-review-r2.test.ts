import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportHostWorktree, materializeHostWorktree, snapshotLocalWorkspaceWip } from "./ssh-host-worktree.js";
import { importHostWorktreeReferences } from "./ssh-host-worktree-refs.js";
import { TIMEOUT_MS, commit, git, makeServerRepo, hostWorktreeFixture } from "./ssh-host-worktree-test-helpers.js";

const { makeCase, skipped } = hostWorktreeFixture();

async function indexBytes(dir: string) {
  const index = await git(dir, ["rev-parse", "--git-path", "index"]);
  return await readFile(path.resolve(dir, index));
}

describe("host worktree review round 2", () => {
  it("preserves newly staged ignored files in both directions without changing real indexes", async () => {
    if (skipped("new staged ignored files")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await commit(server, ".gitignore", "*.cache\nnode_modules/\n", "ignore caches");
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    for (const dir of [server, c.worktree]) {
      await writeFile(path.join(dir, "generated cache.cache"), "explicitly staged\n");
      await git(dir, ["add", "-f", "generated cache.cache"]);
      await writeFile(path.join(dir, "omitted.cache"), "ignored and unstaged\n");
      await writeFile(path.join(dir, "deleted.cache"), "staged then deleted\n");
      await git(dir, ["add", "-f", "deleted.cache"]);
      await rm(path.join(dir, "deleted.cache"));
      await mkdir(path.join(dir, "node_modules"), { recursive: true });
      await writeFile(path.join(dir, "node_modules", "sentinel.cache"), "excluded staged data\n");
      await git(dir, ["add", "-f", "node_modules/sentinel.cache"]);
      const before = await indexBytes(dir);
      const result = dir === server
        ? await snapshotLocalWorkspaceWip({ localDir: server })
        : await exportHostWorktree({ ...c.target, runId: "new-staged-ignored", startHeadSha: head, localDir: server });
      expect(result.wipSha).not.toBeNull();
      if ("dirty" in result) expect(result.dirty).toBe(true);
      expect(await git(server, ["show", `${result.wipSha}:generated cache.cache`])).toBe("explicitly staged");
      const paths = await git(server, ["ls-tree", "-r", "--name-only", result.wipSha!]);
      expect(paths).not.toContain("sentinel.cache");
      expect(paths).not.toContain("omitted.cache");
      expect(paths).not.toContain("deleted.cache");
      expect(await indexBytes(dir)).toEqual(before);
    }
  }, TIMEOUT_MS);

  for (const packed of [false, true]) {
    for (const bundled of [false, true]) {
      for (const names of [["topic", "topic/child"], ["topic/child", "topic"]]) {
        it(`replaces ${names.join(" with ")} (packed=${packed}, bundle=${bundled})`, async () => {
          const server = await makeServerRepo();
          const source = await makeServerRepo();
          const old = await git(server, ["rev-parse", "HEAD"]);
          const next = bundled ? await commit(source, "new.txt", "new object\n", "new commit") : old;
          const prefix = "refs/paperclip/test-import";
          const bundlePath = path.join(source, "export.bundle");
          async function importManifest(name: string, sha: string, bundleBytes: number) {
            return await importHostWorktreeReferences({
              localDir: server, bundlePath, bundleBytes, prefix, runId: "replacement", headSha: sha, wipSha: "",
              stdout: `PAPERCLIP_HOST_REF\t${sha}\trefs/heads/${name}\n`,
            });
          }
          await importManifest(names[0], old, 0);
          if (packed) await git(server, ["pack-refs", "--all", "--prune"]);
          if (bundled) {
            await git(source, ["update-ref", `refs/heads/${names[1]}`, next]);
            await git(source, ["update-ref", "refs/paperclip/export/replacement", next]);
            await git(source, ["bundle", "create", bundlePath, `refs/heads/${names[1]}`, "refs/paperclip/export/replacement"]);
          }
          const imported = await importManifest(names[1], next, bundled ? 1 : 0);
          expect(await git(server, ["rev-parse", imported[0].importedRef])).toBe(next);
          const refs = await git(server, ["for-each-ref", "--format=%(refname)", `${prefix}/references/`]);
          expect(refs).toBe(`${prefix}/references/heads/${names[1]}`);
          expect(await git(server, ["for-each-ref", "--format=%(refname)", "refs/paperclip/host-import/"])).toBe("");
        }, TIMEOUT_MS);
      }
    }
  }

  it("preserves old and new objects through recovery references if manifest installation fails", async () => {
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    const prefix = "refs/paperclip/test-import";
    const old = await git(server, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit-tree", "HEAD^{tree}", "-m", "old reference"]);
    await git(server, ["update-ref", `${prefix}/references/heads/obsolete`, old]);
    const gitDir = path.resolve(server, await git(server, ["rev-parse", "--git-dir"]));
    await mkdir(path.join(gitDir, "refs", "paperclip", "test-import"), { recursive: true });
    await writeFile(path.join(gitDir, "refs", "paperclip", "test-import", "head.lock"), "contending writer\n");
    await expect(importHostWorktreeReferences({
      localDir: server, bundlePath: "unused", bundleBytes: 0, prefix, runId: "failure", headSha: head, wipSha: "", stdout: "",
    })).rejects.toThrow("cannot lock ref");
    const recovery = await git(server, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/paperclip/host-import/"]);
    expect(recovery).toContain(`${old} refs/paperclip/host-import/`);
    expect(recovery).toContain(`${head} refs/paperclip/host-import/`);
    expect(recovery).toContain("/previous/references/heads/obsolete");
    expect(recovery).toContain("/desired/head");
    expect(await git(server, ["for-each-ref", "--format=%(refname)", `${prefix}/references/`])).toBe("");
  }, TIMEOUT_MS);
});
