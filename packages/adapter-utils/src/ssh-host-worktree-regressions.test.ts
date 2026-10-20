import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireHostWorktreeLock, buildHostLockReleaseScript, exportHostWorktree, hostLockDir,
  materializeHostWorktree, snapshotLocalWorkspaceWip,
} from "./ssh-host-worktree.js";
import { shellQuote } from "./ssh-config.js";
import { TIMEOUT_MS, EW, commit, git, makeServerRepo, hostWorktreeFixture } from "./ssh-host-worktree-test-helpers.js";

const { makeCase, skipped } = hostWorktreeFixture();

async function shell(script: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("sh", ["-c", script], { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5000;
  while (!(await stat(file).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function indexBytes(dir: string) {
  const index = await git(dir, ["rev-parse", "--git-path", "index"]);
  return await readFile(path.resolve(dir, index));
}

describe("host worktree review regressions", () => {
  it("transfers uncommitted edits in both directions with unchanged HEAD", async () => {
    if (skipped("unchanged HEAD WIP")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    await writeFile(path.join(server, "a.txt"), "server WIP\n");
    const snapshot = await snapshotLocalWorkspaceWip({ localDir: server });
    const materialized = await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w", wipSha: snapshot.wipSha });
    expect(materialized.fullBundle).toBe(false);
    expect(await readFile(path.join(c.worktree, "a.txt"), "utf8")).toBe("server WIP\n");
    await writeFile(path.join(c.worktree, "a.txt"), "host WIP\n");
    const exported = await exportHostWorktree({ ...c.target, runId: "unchanged-head", startHeadSha: head, localDir: server });
    expect(exported).toMatchObject({ headSha: head, dirty: true });
    expect(await git(server, ["show", `${exported.wipSha}:a.txt`])).toBe("host WIP");
  }, TIMEOUT_MS);

  it("excludes staged runtime paths and preserves tracked ignored files and both real indexes", async () => {
    if (skipped("temporary index exclusions")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    await commit(server, ".gitignore", "node_modules/\ntracked.cache\n", "ignore cache");
    await writeFile(path.join(server, "tracked.cache"), "tracked\n");
    await git(server, ["add", "-f", "tracked.cache"]);
    await git(server, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "track ignored cache"]);
    await commit(server, "removed.txt", "delete this file\n", "deletion base");
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    for (const dir of [server, c.worktree]) {
      for (const excluded of ["node_modules", ".paperclip-runtime", ".worktrees"]) {
        await mkdir(path.join(dir, excluded), { recursive: true });
        await writeFile(path.join(dir, excluded, "sentinel.txt"), "excluded staged data\n");
        await git(dir, ["add", "-f", `${excluded}/sentinel.txt`]);
      }
      await writeFile(path.join(dir, "a.txt"), "staged\n");
      await git(dir, ["add", "a.txt"]);
      await writeFile(path.join(dir, "a.txt"), "unstaged\n");
      await writeFile(path.join(dir, "tracked.cache"), "changed ignored file\n");
      await rm(path.join(dir, "removed.txt"));
      const before = await indexBytes(dir);
      const snapshot = dir === server
        ? await snapshotLocalWorkspaceWip({ localDir: server })
        : await exportHostWorktree({ ...c.target, runId: "excluded-staged", startHeadSha: head, localDir: server });
      expect(snapshot.wipSha).not.toBeNull();
      expect(await indexBytes(dir)).toEqual(before);
      const files = await git(server, ["ls-tree", "-r", "--name-only", snapshot.wipSha!]);
      expect(files).not.toContain("sentinel.txt");
      expect(files).not.toContain("removed.txt");
      expect(await git(server, ["show", `${snapshot.wipSha}:tracked.cache`])).toBe("changed ignored file");
      expect(await git(server, ["show", `${snapshot.wipSha}:a.txt`])).toBe("unstaged");
    }
  }, TIMEOUT_MS);

  it("exports divergent branches, annotated tags, and remote references into a scoped manifest", async () => {
    if (skipped("reference manifest")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const start = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: start, branch: "w" });
    await git(c.worktree, ["checkout", "-qb", "topic"]);
    const topic = await commit(c.worktree, "topic.txt", "divergent\n", "topic commit");
    await git(c.worktree, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-am", "annotated", "v1"]);
    const tag = await git(c.worktree, ["rev-parse", "refs/tags/v1"]);
    await git(c.worktree, ["update-ref", "refs/remotes/origin/topic", topic]);
    await git(c.worktree, ["checkout", "-q", "w"]);
    const input = { ...c.target, runId: "refs-only", startHeadSha: start, localDir: server };
    const exported = await exportHostWorktree(input);
    expect(exported).toMatchObject({ headSha: start, dirty: false });
    expect(exported.bundleBytes).toBeGreaterThan(0);
    for (const [ref, sha] of [["refs/heads/topic", topic], ["refs/tags/v1", tag], ["refs/remotes/origin/topic", topic]]) {
      const entry = exported.references.find((item) => item.ref === ref)!;
      expect(entry).toMatchObject({ sha });
      expect(entry.importedRef).toContain(`/${c.target.repoKey}/${c.target.worktreeName}/`);
      expect(await git(server, ["rev-parse", entry.importedRef])).toBe(sha);
    }
    expect(await git(server, ["for-each-ref", "--format=%(refname)", "refs/heads/topic", "refs/tags/v1", "refs/remotes/origin/topic"])).toBe("");
    // Reference moves and deletion need no new commits, but the manifest must change.
    await git(c.worktree, ["update-ref", "refs/heads/topic", start]);
    await git(c.worktree, ["update-ref", "-d", "refs/tags/v1"]);
    await git(c.worktree, ["update-ref", "-d", "refs/remotes/origin/topic"]);
    const reset = await exportHostWorktree(input);
    expect(reset.bundleBytes).toBe(0);
    expect(reset.references.find((item) => item.ref === "refs/heads/topic")?.sha).toBe(start);
    const oldTag = exported.references.find((item) => item.ref === "refs/tags/v1")!;
    expect(await git(server, ["for-each-ref", "--format=%(refname)", oldTag.importedRef])).toBe("");
  }, TIMEOUT_MS);

  it("exports a new annotated tag whose target is an existing prerequisite", async () => {
    if (skipped("tag-only objects")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    await git(c.worktree, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "tag", "-am", "tag only", "v1"]);
    const exported = await exportHostWorktree({ ...c.target, runId: "tag-only", startHeadSha: head, localDir: server });
    const tag = exported.references.find((entry) => entry.ref === "refs/tags/v1")!;
    expect(await git(server, ["cat-file", "-t", tag.sha])).toBe("tag");
    expect(await git(server, ["rev-parse", `${tag.importedRef}^{commit}`])).toBe(head);
  }, TIMEOUT_MS);

  it("serializes concurrent stale releases with a replacement acquisition", async () => {
    if (skipped("concurrent stale release")) return;
    const c = makeCase()!;
    const first = await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-a" });
    const lockDir = hostLockDir(c.layout, EW);
    const owner = await readFile(path.join(lockDir, "owner.json"), "utf8");
    const scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-lock-race-"));
    const ready = path.join(scratch, "read-owner");
    const resume = path.join(scratch, "resume");
    // Pause one remover after it reads A's owner file. All mutation paths must serialize here.
    const paused = shell(`cat() { command cat "$@"; touch ${shellQuote(ready)}; while [ ! -f ${shellQuote(resume)} ]; do sleep 0.01; done; }\n${buildHostLockReleaseScript({ lockDir, expectedOwnerJson: owner })}`);
    let replacement: Awaited<ReturnType<typeof acquireHostWorktreeLock>> | undefined;
    try {
      await waitForFile(ready);
      const staleRelease = first.release();
      const acquiring = acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-b", waitMs: 5000, pollMs: 20 });
      // Give both contenders time to attempt their mutation while the first remover is paused.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await writeFile(resume, "resume");
      await paused;
      replacement = await acquiring;
      expect(["absent", "not_owner"]).toContain(await staleRelease);
      expect(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).runId).toBe("run-b");
      await expect(acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-c", waitMs: 100, pollMs: 20 }))
        .rejects.toMatchObject({ code: "host_lock_timeout" });
    } finally {
      await writeFile(resume, "resume");
      await paused.catch(() => undefined);
      await replacement?.release();
      await rm(scratch, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
