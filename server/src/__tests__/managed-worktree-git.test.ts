import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasOwnLinkedWorktreeGitDirectory, repairMissingManagedWorktreeGit } from "../services/managed-worktree-git.js";
import { decideSshInPlaceRealization, readSshInPlaceWorktreeLockHolder, probeSshInPlaceWorkspace } from "../services/ssh-in-place-workspace.js";
import { cleanupExecutionWorkspaceArtifacts, inspectManagedGitWorktreeBranch, ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}
const config = { host: "fixture", username: "fixture", port: 22, remoteWorkspacePath: "/unused",
  privateKey: null, knownHosts: null, strictHostKeyChecking: false };
async function fixture() {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-boundary-")));
  roots.push(repo);
  vi.stubEnv("PAPERCLIP_HOME", path.join(repo, "instance"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(repo, "source.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Initial fixture");
  const worktree = path.join(repo, ".paperclip", "worktrees", "issue");
  await git(repo, "worktree", "add", "-b", "issue", worktree);
  const marker = path.join(worktree, ".git");
  const admin = await git(worktree, "rev-parse", "--absolute-git-dir");
  const parentIndex = createHash("sha256").update(await fs.readFile(path.join(repo, ".git", "index"))).digest("hex");
  return { repo, worktree, marker, admin, parentIndex };
}
async function probe(worktree: string) {
  return probeSshInPlaceWorkspace({ config, localPath: worktree,
    runSsh: async (_config, script) => exec("sh", ["-c", script]) });
}
async function persisted(f: Awaited<ReturnType<typeof fixture>>) {
  return ensurePersistedExecutionWorkspaceAvailable({
    base: { cwd: f.repo, baseCwd: f.repo, source: "project", repoRef: "main", warnings: [] },
    workspace: { id: "workspace", cwd: f.worktree, providerRef: f.worktree, providerType: "git_worktree",
      strategyType: "git_worktree", branchName: "issue", baseRef: "main", config: {},
      metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } },
    issue: null, agent: { id: "agent", name: "Fixture", companyId: "company" },
  } as Parameters<typeof ensurePersistedExecutionWorkspaceAvailable>[0]);
}
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("managed worktree Git identity", () => {
  it("accepts the linked worktree and rejects the managed checkout", async () => {
    const f = await fixture();
    expect(await hasOwnLinkedWorktreeGitDirectory(f.worktree, f.repo)).toBe(true);
    expect(await hasOwnLinkedWorktreeGitDirectory(f.repo, f.repo)).toBe(false);
    expect(await probe(f.worktree)).toEqual({ ok: true });
    expect(await probe(f.repo)).toEqual({ ok: true });
  });

  it("rejects parent discovery in the probe, and validation", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    expect(await git(f.worktree, "rev-parse", "--show-toplevel")).toBe(f.repo);
    expect(await probe(f.worktree)).toMatchObject({ ok: false, reason: "host_git_unusable" });
    expect(await inspectManagedGitWorktreeBranch({ worktreePath: f.worktree, repoRoot: f.repo, expectedBranchName: "issue" }))
      .toMatchObject({ valid: false, reasonCode: "wrong_repository_root" });
  });

  it("selects copy mode and releases ownership when the Git link is absent", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    const remote = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-runtime-")));
    roots.push(remote);
    const decision = await decideSshInPlaceRealization({
      environmentId: "environment", adapterType: "codex_local", localPath: f.worktree, remoteCwd: remote,
      leaseId: "boundary-lease", runId: "boundary-run", resolveConfig: async () => config,
      env: { PAPERCLIP_SSH_IN_PLACE_ENVIRONMENTS: "environment" }, isHolderActive: async () => false,
      runSsh: async (_config, script) => exec("sh", ["-c", script]),
    });
    expect(decision).toMatchObject({ mode: "copy", warn: true });
    expect(decision).toHaveProperty("reason", `host_git_unusable: ${f.worktree}`);
    expect(readSshInPlaceWorktreeLockHolder(f.worktree)).toBeNull();
  });

  it("rejects a foreign administration directory even when the top level matches", async () => {
    const f = await fixture();
    const other = path.join(f.repo, ".paperclip", "worktrees", "other");
    await git(f.repo, "worktree", "add", "-b", "other", other);
    await fs.copyFile(path.join(other, ".git"), f.marker);
    expect(await git(f.worktree, "rev-parse", "--show-toplevel")).toBe(f.worktree);
    expect(await hasOwnLinkedWorktreeGitDirectory(f.worktree, f.repo)).toBe(false);
    expect(await probe(f.worktree)).toMatchObject({ ok: false, reason: "host_git_unusable" });
    expect(await inspectManagedGitWorktreeBranch({ worktreePath: f.worktree, repoRoot: f.repo, expectedBranchName: "issue" }))
      .toMatchObject({ valid: false, reasonCode: "wrong_git_directory" });
  });

  it("rejects a symlink marker", async () => {
    const f = await fixture();
    const saved = path.join(f.repo, "marker-copy");
    await fs.rename(f.marker, saved);
    await fs.symlink(saved, f.marker);
    expect(await hasOwnLinkedWorktreeGitDirectory(f.worktree, f.repo)).toBe(false);
    expect(await probe(f.worktree)).toMatchObject({ ok: false, reason: "host_git_unusable" });
  });

  it("restores the missing link before branch repair and preserves both indexes", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.worktree, "source.txt"), "staged edit\n");
    await git(f.worktree, "add", "source.txt");
    await fs.writeFile(path.join(f.worktree, "untracked.txt"), "untracked\n");
    const ownIndex = await fs.readFile(path.join(f.admin, "index"));
    const marker = await fs.readFile(f.marker, "utf8");
    await fs.unlink(f.marker);
    const restored = await persisted(f);
    expect(restored?.branchName).toBe("issue");
    expect(restored?.warnings?.join("\n")).toContain("Restored the Git link");
    expect(await fs.readFile(f.marker, "utf8")).toBe(marker);
    expect(await fs.readFile(path.join(f.admin, "index"))).toEqual(ownIndex);
    expect(await fs.readFile(path.join(f.worktree, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(createHash("sha256").update(await fs.readFile(path.join(f.repo, ".git", "index"))).digest("hex")).toBe(f.parentIndex);
    expect(await git(f.repo, "branch", "--show-current")).toBe("main");
  });

  it("preserves an orphan folder before reconstruction on the recorded branch", async () => {
    const f = await fixture();
    const tip = await git(f.worktree, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.worktree, "unsaved.txt"), "preserve me");
    await fs.unlink(f.marker);
    await fs.rm(f.admin, { recursive: true });
    const warnings = await repairMissingManagedWorktreeGit({ repoRoot: f.repo, worktreePath: f.worktree, branchName: "issue", runtimeOwned: true });
    expect(warnings[0]).toContain("Reconstructed");
    const quarantineRoot = path.join(f.repo, ".paperclip", "worktree-quarantine");
    const quarantine = (await fs.readdir(quarantineRoot))[0]!;
    expect(await fs.readFile(path.join(quarantineRoot, quarantine, "unsaved.txt"), "utf8")).toBe("preserve me");
    expect(await git(f.worktree, "rev-parse", "HEAD")).toBe(tip);
    expect(await hasOwnLinkedWorktreeGitDirectory(f.worktree, f.repo)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "preserves the branch when a protected file prevents complete worktree removal", async () => {
      const f = await fixture();
      const locked = path.join(f.worktree, "protected");
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, "unsaved.txt"), "unsaved");
      await fs.chmod(locked, 0o500);
      try {
        const result = await cleanupExecutionWorkspaceArtifacts({
          workspace: { id: "workspace", companyId: "company", providerType: "git_worktree",
            cwd: f.worktree, providerRef: f.worktree, branchName: "issue",
            metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } },
          projectWorkspace: { cwd: f.repo, cleanupCommand: null }, runCleanupCommands: false,
        });
        expect(result.cleaned).toBe(false);
        expect(result.warnings.join("\n")).toContain("Preserved branch");
        // Git can remove metadata before it reports a partial deletion.
        // Directory traversal order determines which entries remain.
        expect(result.warnings.join("\n")).toContain("Permission denied");
        expect(await git(f.repo, "rev-parse", "refs/heads/issue")).toBe(await git(f.repo, "rev-parse", "HEAD"));
        expect(await fs.readFile(path.join(locked, "unsaved.txt"), "utf8")).toBe("unsaved");
      } finally { await fs.chmod(locked, 0o700); }
    },
  );

  it("does not reconstruct an operator-owned branch", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    await fs.rm(f.admin, { recursive: true });
    expect(await repairMissingManagedWorktreeGit({ repoRoot: f.repo, worktreePath: f.worktree, branchName: "issue", runtimeOwned: false })).toEqual([]);
    expect(await fs.readdir(path.dirname(f.worktree))).toEqual(["issue"]);
  });

  it("records a workspace failure when the recorded branch no longer exists", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    await fs.rm(f.admin, { recursive: true });
    await git(f.repo, "branch", "-D", "issue");
    await expect(persisted(f)).rejects.toMatchObject({ code: "workspace_validation_failed",
      resultJson: { workspaceValidation: { reason: "git_worktree_not_reusable", reasonCode: "git_metadata_repair_failed" } } });
    expect(await fs.readFile(path.join(f.worktree, "source.txt"), "utf8")).toBe("base\n");
  });

  it("serializes two callers that restore the same missing marker", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    const input = { repoRoot: f.repo, worktreePath: f.worktree, branchName: "issue", runtimeOwned: true };
    const results = await Promise.all([repairMissingManagedWorktreeGit(input), repairMissingManagedWorktreeGit(input)]);
    expect(results.flat()).toHaveLength(1);
    expect(await hasOwnLinkedWorktreeGitDirectory(f.worktree, f.repo)).toBe(true);
  });

  it("does not detach a branch registered at another path", async () => {
    const f = await fixture();
    await fs.unlink(f.marker);
    await fs.rm(f.admin, { recursive: true });
    const other = path.join(f.repo, "other");
    await git(f.repo, "worktree", "add", other, "issue");
    expect(await repairMissingManagedWorktreeGit({ repoRoot: f.repo, worktreePath: f.worktree, branchName: "issue", runtimeOwned: true })).toEqual([]);
    expect(await git(other, "branch", "--show-current")).toBe("issue");
  });
});
