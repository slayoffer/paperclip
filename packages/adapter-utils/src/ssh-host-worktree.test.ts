import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { integrateImportedGitHead } from "./git-workspace-sync.js";
import {
  HostWorktreeError,
  acquireHostWorktreeLock,
  adoptHostWorktree,
  assertHostBranchName,
  assertHostWorktreeId,
  exportHostWorktree,
  hostLockDir,
  hostSiblingWorktreeName,
  inventoryHostRepo,
  materializeHostWorktree,
  readHostWorktreeState,
  removeHostWorktree,
  resolveHostWorktreeLayout,
  snapshotLocalWorkspaceWip,
  writeHostWorktreeState,
} from "./ssh-host-worktree.js";

import { TIMEOUT_MS, EW, commit, git, makeServerRepo, hostWorktreeFixture } from "./ssh-host-worktree-test-helpers.js";

const { makeCase, skipped } = hostWorktreeFixture();

describe("host worktree identifiers", () => {
  it("rejects unsafe ids and branch names", () => {
    expect(() => assertHostWorktreeId("run id", "../x")).toThrow();
    expect(() => assertHostWorktreeId("run id", "-rf")).toThrow();
    expect(() => assertHostBranchName("-x")).toThrow();
    expect(() => assertHostBranchName("a..b")).toThrow();
    expect(() => assertHostBranchName("a/.b")).toThrow();
    expect(assertHostBranchName("review/SYNA-2273")).toBe("review/SYNA-2273");
    expect(hostSiblingWorktreeName("SYNA-1-ew000001", "0123456789abcdef")).toBe("SYNA-1-ew000001@01234567");
    expect(() => resolveHostWorktreeLayout("relative/path")).toThrow();
  });
});

describe("ssh host worktrees", () => {
  it("materializes on a fresh host and then sends empty and small deltas", async () => {
    if (skipped("fresh host test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);

    expect(await inventoryHostRepo(c.target)).toEqual({ bareExists: false, knownHeads: [] });
    const first = await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "SYNA-1-work" });
    expect(first).toMatchObject({ action: "created", fullBundle: true, headSha: head });
    expect(first.bundleBytes).toBeGreaterThan(0);
    expect(await git(c.worktree, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(c.worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("SYNA-1-work");
    expect(await readFile(path.join(c.worktree, "a.txt"), "utf8")).toBe("one\n");
    expect((await inventoryHostRepo(c.target)).knownHeads).toEqual([head]);

    const second = await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "SYNA-1-work" });
    expect(second).toMatchObject({ action: "moved", bundleBytes: 0, fullBundle: false });

    const next = await commit(server, "b.txt", "two\n", "second");
    const third = await materializeHostWorktree({ ...c.target, localDir: server, headSha: next, branch: "SYNA-1-work" });
    expect(third).toMatchObject({ action: "moved", fullBundle: false });
    expect(third.bundleBytes).toBeGreaterThan(0);
    expect(third.bundleBytes).toBeLessThan(first.bundleBytes + 1024);
    expect(await git(c.worktree, ["rev-parse", "HEAD"])).toBe(next);

    await writeHostWorktreeState({ ...c.target, ewId: EW, state: { headSha: next, wipSha: null, runId: "run-1", status: "running" } });
    expect(await readHostWorktreeState({ ...c.target, ewId: EW })).toMatchObject({ headSha: next, status: "running", runId: "run-1" });
  }, TIMEOUT_MS);

  it("keeps ignored node_modules across a materialize and out of WIP", async () => {
    if (skipped("node_modules test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    await mkdir(path.join(c.worktree, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(c.worktree, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    const next = await commit(server, "c.txt", "three\n", "third");
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: next, branch: "w" });
    expect(await readFile(path.join(c.worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");

    const exported = await exportHostWorktree({ ...c.target, runId: "run-nm", startHeadSha: next, localDir: server });
    expect(exported).toMatchObject({ headSha: next, dirty: false, wipSha: null, bundleBytes: 0 });
  }, TIMEOUT_MS);

  it("round-trips WIP from the server to the host and back", async () => {
    if (skipped("WIP round trip test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    await writeFile(path.join(server, "a.txt"), "server edit\n");
    await writeFile(path.join(server, "new.txt"), "untracked\n");
    const { headSha, wipSha } = await snapshotLocalWorkspaceWip({ localDir: server });
    expect(wipSha).not.toBeNull();
    expect(await git(server, ["status", "--porcelain"])).toContain("a.txt");

    await materializeHostWorktree({ ...c.target, localDir: server, headSha, branch: "w", wipSha });
    expect(await readFile(path.join(c.worktree, "a.txt"), "utf8")).toBe("server edit\n");
    expect(await readFile(path.join(c.worktree, "new.txt"), "utf8")).toBe("untracked\n");
    expect(await git(c.worktree, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await git(c.worktree, ["rev-parse", "HEAD"])).toBe(headSha);

    const hostCommit = await commit(c.worktree, "host.txt", "host\n", "host work");
    await writeFile(path.join(c.worktree, "a.txt"), "host edit\n");
    const exported = await exportHostWorktree({ ...c.target, runId: "run-wip", startHeadSha: headSha, localDir: server });
    expect(exported).toMatchObject({ headSha: hostCommit, dirty: true, branch: "w" });
    expect(await git(server, ["rev-parse", exported.importedHeadRef])).toBe(hostCommit);
    expect(await git(server, ["show", `${exported.wipSha}:a.txt`])).toBe("host edit");
    expect(await git(server, ["show", `${exported.wipSha}:new.txt`])).toBe("untracked");
    expect(await git(server, ["rev-parse", `${exported.wipSha}^`])).toBe(hostCommit);
    // The host branch and index stay untouched by the snapshot.
    expect(await git(c.worktree, ["rev-parse", "HEAD"])).toBe(hostCommit);
    expect(await git(c.worktree, ["diff", "--cached", "--name-only"])).toBe("");
  }, TIMEOUT_MS);

  it("exports a non-fast-forward head that the server integrates as a merge", async () => {
    if (skipped("non-fast-forward test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const start = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: start, branch: "w" });
    const hostHead = await commit(c.worktree, "host.txt", "host\n", "host side");
    const serverHead = await commit(server, "server.txt", "server\n", "server side");

    const exported = await exportHostWorktree({ ...c.target, runId: "run-nff", startHeadSha: start, localDir: server });
    expect(exported.headSha).toBe(hostHead);
    expect(exported.bundleBytes).toBeGreaterThan(0);
    await integrateImportedGitHead({ localDir: server, importedHead: exported.headSha });
    const parents = (await git(server, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ").slice(1);
    expect(parents).toEqual([serverHead, hostHead]);
  }, TIMEOUT_MS);

  it("waits on a live lock and breaks a stale one", async () => {
    if (skipped("stale lock test")) return;
    const c = makeCase()!;
    const first = await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-a" });
    expect(first.reentered).toBe(false);
    const ownerFile = JSON.parse(await readFile(path.join(hostLockDir(c.layout, EW), "owner.json"), "utf8"));
    expect(ownerFile).toMatchObject({ runId: "run-a", pid: process.pid });

    await expect(acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-b", waitMs: 300, pollMs: 100, isOwnerStale: () => false }))
      .rejects.toMatchObject({ code: "host_lock_timeout" });
    const second = await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-b", isOwnerStale: (owner) => owner.runId === "run-a" });
    expect(second.brokenOwner?.runId).toBe("run-a");
    expect(await first.release()).toBe("not_owner");
    expect(await second.release()).toBe("released");
    await expect(stat(hostLockDir(c.layout, EW))).rejects.toThrow();

    // A lock dir without owner.json (crash between mkdir and write) is broken after the grace period.
    await mkdir(hostLockDir(c.layout, EW), { recursive: true });
    const third = await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-c", ownerlessStaleSeconds: 0 });
    expect(await third.release()).toBe("released");
  }, TIMEOUT_MS);

  it("adopts the leftover work of a killed run and then removes the worktree", async () => {
    if (skipped("adopt test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const start = await git(server, ["rev-parse", "HEAD"]);
    await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-killed" });
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: start, branch: "w" });
    await writeHostWorktreeState({ ...c.target, ewId: EW, state: { headSha: start, wipSha: null, runId: "run-killed", status: "running" } });
    const hostHead = await commit(c.worktree, "crash.txt", "before crash\n", "crashed run work");
    await writeFile(path.join(c.worktree, "dirty.txt"), "unsaved\n");
    // The run dies here: no export, no release.

    const lock = await acquireHostWorktreeLock({ ...c.target, ewId: EW, runId: "run-next", isOwnerStale: (owner) => owner.runId === "run-killed" });
    expect(lock.brokenOwner?.runId).toBe("run-killed");
    const adopted = await adoptHostWorktree({ ...c.target, ewId: EW, runId: "run-next", localDir: server });
    if (!adopted.adopted) throw new Error(`expected adoption, got ${adopted.reason}`);
    expect(adopted.export.headSha).toBe(hostHead);
    expect(await git(server, ["show", `${adopted.export.wipSha}:dirty.txt`])).toBe("unsaved");

    await writeHostWorktreeState({ ...c.target, ewId: EW, state: { headSha: hostHead, wipSha: adopted.export.wipSha, runId: "run-next", status: "synced" } });
    expect(await adoptHostWorktree({ ...c.target, ewId: EW, runId: "run-next", localDir: server })).toMatchObject({ adopted: false, reason: "in_sync" });

    expect(await removeHostWorktree({ ...c.target, ewId: EW, expectedHeadSha: start })).toBe("head_mismatch");
    expect(await removeHostWorktree({ ...c.target, ewId: EW, expectedHeadSha: hostHead })).toBe("dirty");
    await rm(path.join(c.worktree, "dirty.txt"));
    expect(await removeHostWorktree({ ...c.target, ewId: EW, expectedHeadSha: hostHead })).toBe("removed");
    await expect(stat(c.worktree)).rejects.toThrow();
    expect(await readHostWorktreeState({ ...c.target, ewId: EW })).toBeNull();
    expect(await removeHostWorktree({ ...c.target, ewId: EW, expectedHeadSha: hostHead })).toBe("absent");
    await lock.release();
  }, TIMEOUT_MS);

  it("creates a sibling worktree from the same bare repo", async () => {
    if (skipped("sibling test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    const sibling = hostSiblingWorktreeName(c.target.worktreeName, "run-sibling-1");
    const result = await materializeHostWorktree({ ...c.target, worktreeName: sibling, localDir: server, headSha: head, branch: null });
    expect(result).toMatchObject({ action: "created", bundleBytes: 0 });
    expect(await git(result.worktreePath, ["rev-parse", "HEAD"])).toBe(head);
    // Git refuses a branch that another worktree holds, so siblings run detached.
    expect(await git(result.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  }, TIMEOUT_MS);

  it("fails with wip_too_large and names the largest paths", async () => {
    if (skipped("WIP cap test")) return;
    const c = makeCase()!;
    const server = await makeServerRepo();
    const head = await git(server, ["rev-parse", "HEAD"]);
    await materializeHostWorktree({ ...c.target, localDir: server, headSha: head, branch: "w" });
    await writeFile(path.join(c.worktree, "big.bin"), Buffer.alloc(300 * 1024, 7));
    const error = await exportHostWorktree({ ...c.target, runId: "run-cap", startHeadSha: head, localDir: server, wipMaxBytes: 100 * 1024 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostWorktreeError);
    expect(error).toMatchObject({ code: "wip_too_large" });
    expect((error as Error).message).toContain("big.bin");

    await writeFile(path.join(server, "big.bin"), Buffer.alloc(300 * 1024, 7));
    await expect(snapshotLocalWorkspaceWip({ localDir: server, wipMaxBytes: 100 * 1024 })).rejects.toMatchObject({ code: "wip_too_large" });
  }, TIMEOUT_MS);
});
