import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalGit } from "./ssh-command.js";
import { readLocalGitWorkspaceSnapshot, transportGitWorkspaceToSsh } from "./ssh-git.js";

// Execute the production import script and real bundle locally. Only the SSH
// pipe and file overlay are replaced. No network or SSH server is required.
vi.mock("./ssh-transfer-progress.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ssh-transfer-progress.js")>(),
  streamLocalFileToSsh: async (input: { localFile: string; remoteScript: string }) => {
    const result = await shell(input.remoteScript, await readFile(input.localFile));
    if (result.code !== 0) throw new Error(result.output);
  },
}));
vi.mock("./ssh-sync.js", () => ({
  syncDirectoryToSsh: vi.fn(),
  removeDeletedPathsOnSsh: vi.fn(),
}));

function shell(script: string, stdin: Buffer | string = "", cwd?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("bash", ["-c", script], { cwd, stdio: "pipe" });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output: Buffer.concat(output).toString() }));
    child.stdin.end(stdin);
  });
}
async function git(cwd: string, args: string[]) {
  return (await runLocalGit(cwd, args, { maxBuffer: 1024 * 1024 })).stdout.trim();
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-refs-"));
  roots.push(root);
  const source = path.join(root, "source");
  const copied = path.join(root, "copied workspace's files");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.name", "Paperclip Test"]);
  await git(source, ["config", "user.email", "test@paperclip.dev"]);
  await git(source, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
  const historical = await commit(source, "history.txt", "old content\n");
  const baseline = await commit(source, "history.txt", "baseline\n");
  await git(source, ["update-ref", "refs/remotes/origin/main", baseline]);
  await git(source, ["update-ref", "refs/remotes/backup/release", historical]);
  await git(source, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(source, ["checkout", "-b", "review/test"]);
  const head = await commit(source, "candidate.txt", "candidate\n");
  return { root, source, copied, historical, baseline, head };
}

// Construct fixture history directly. The negative control deliberately adds
// a generated, invalid credential for the publication hook to reject.
async function commit(repo: string, name: string, content: string) {
  await writeFile(path.join(repo, name), content);
  await git(repo, ["add", name]);
  const tree = await git(repo, ["write-tree"]);
  const parent = await git(repo, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  const head = await git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "test fixture"]);
  await git(repo, ["update-ref", "HEAD", head]);
  return head;
}
async function copy(source: string, copied: string) {
  const snapshot = await readLocalGitWorkspaceSnapshot(source);
  if (!snapshot) throw new Error("Fixture snapshot is absent");
  await transportGitWorkspaceToSsh({
    localDir: source, remoteDir: copied, snapshot, progressLabel: "test",
    spec: { host: "unused", port: 22, username: "unused", remoteWorkspacePath: copied,
      remoteCwd: copied, privateKey: null, knownHosts: null, strictHostKeyChecking: false },
  });
}

describe("SSH workspace publication baselines", { timeout: 30_000 }, () => {
  it("preserves packed remote references and symbolic HEAD from a linked worktree", async () => {
    const f = await fixture();
    await git(f.source, ["pack-refs", "--all"]);
    const worktree = path.join(f.root, "linked");
    await git(f.source, ["worktree", "add", "--detach", worktree, f.head]);
    await copy(worktree, f.copied);
    expect(await git(f.copied, ["rev-parse", "refs/remotes/origin/main"])).toBe(f.baseline);
    expect(await git(f.copied, ["rev-parse", "refs/remotes/backup/release"])).toBe(f.historical);
    expect(await git(f.copied, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe("refs/remotes/origin/main");
    expect(await git(f.copied, ["merge-base", "HEAD", "origin/HEAD"])).toBe(f.baseline);
    expect(await git(f.copied, ["rev-list", "origin/main..HEAD"])).toBe(f.head);
    expect(await git(f.copied, ["remote", "get-url", "origin"])).toBe("https://github.com/example/repo.git");
    expect(await git(f.copied, ["for-each-ref", "--format=%(refname)", "refs/paperclip/"])).toBe("");
  });

  it("updates a reused workspace without changing the previous symbolic HEAD target", async () => {
    const f = await fixture();
    await copy(f.source, f.copied);
    await git(f.source, ["update-ref", "refs/remotes/origin/develop", f.historical]);
    await git(f.source, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    await copy(f.source, f.copied);
    expect(await git(f.copied, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe("refs/remotes/origin/develop");
    expect(await git(f.copied, ["rev-parse", "origin/main"])).toBe(f.baseline);
    expect(await git(f.copied, ["rev-parse", "origin/develop"])).toBe(f.historical);
    await git(f.source, ["update-ref", "--no-deref", "refs/remotes/origin/HEAD", f.head]);
    await copy(f.source, f.copied);
    expect(await git(f.copied, ["rev-parse", "origin/HEAD"])).toBe(f.head);
    expect(await git(f.copied, ["rev-parse", "origin/develop"])).toBe(f.historical);
    await expect(git(f.copied, ["symbolic-ref", "refs/remotes/origin/HEAD"])).rejects.toThrow();
  });

  it("copies a repository without remote references", async () => {
    const f = await fixture();
    await git(f.source, ["remote", "remove", "origin"]);
    await git(f.source, ["update-ref", "-d", "refs/remotes/backup/release"]);
    await copy(f.source, f.copied);
    expect(await git(f.copied, ["rev-parse", "HEAD"])).toBe(f.head);
    expect(await git(f.copied, ["for-each-ref", "--format=%(refname)", "refs/remotes/"])).toBe("");
  });

  it("copies many remote references without a large shell argument", async () => {
    const f = await fixture();
    const refs = Array.from({ length: 1000 }, (_, index) =>
      `refs/remotes/origin/${"long-branch-".repeat(15)}${index}`);
    const updates = refs.map((ref) => `update ${ref} ${f.baseline}\n`).join("");
    expect((await shell("git update-ref --stdin", updates, f.source)).code).toBe(0);
    await copy(f.source, f.copied);
    expect(await git(f.copied, ["rev-parse", refs.at(-1)!])).toBe(f.baseline);
    const imported = await git(f.copied, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]);
    expect(imported.split("\n")).toHaveLength(1003);
  });
});

// Run with the installed, unchanged CodeGuard hook when it is available.
// CI still runs the transport regressions above without operator tools.
const hook = process.env.PAPERCLIP_TEST_PRE_PUSH_HOOK ?? path.resolve(".git/hooks/pre-push");
const hookAvailable = existsSync(hook) && spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;
it.skipIf(!hookAvailable)("the unchanged publication hook scans one candidate and rejects a new test secret", async () => {
  const f = await fixture();
  // The historical test credential must not enter the candidate range.
  const historicalToken = `ghp_${randomBytes(18).toString("hex")}`;
  await git(f.source, ["checkout", "--orphan", "fixture-history"]);
  await commit(f.source, "old-credential.txt", `github_token = "${historicalToken}"\n`);
  await rm(path.join(f.source, "old-credential.txt"));
  await git(f.source, ["add", "old-credential.txt"]);
  const tree = await git(f.source, ["write-tree"]);
  const parent = await git(f.source, ["rev-parse", "HEAD"]);
  const baseline = await git(f.source, ["commit-tree", tree, "-p", parent, "-m", "remove test credential"]);
  await git(f.source, ["update-ref", "HEAD", baseline]);
  await git(f.source, ["update-ref", "refs/remotes/origin/main", baseline]);
  await commit(f.source, "clean-candidate.txt", "safe content\n");
  await copy(f.source, f.copied);
  const hookBytes = await readFile(hook);
  async function publication() {
    const head = await git(f.copied, ["rev-parse", "HEAD"]);
    const line = `refs/heads/review/test ${head} refs/heads/review/test ${"0".repeat(40)}\n`;
    // Use the hook file verbatim. No scanner or allowlist setting is changed.
    return shell('bash "$PAPERCLIP_TEST_HOOK" origin https://github.com/example/repo.git', line, f.copied);
  }
  const previous = process.env.PAPERCLIP_TEST_HOOK;
  process.env.PAPERCLIP_TEST_HOOK = hook;
  try {
    const clean = await publication();
    expect(clean.output).toMatch(/1 commits? scanned/);
    expect(clean.code, clean.output).toBe(0);
    const token = `ghp_${randomBytes(18).toString("hex")}`;
    await git(f.copied, ["config", "user.name", "Paperclip Test"]);
    await git(f.copied, ["config", "user.email", "test@paperclip.dev"]);
    await commit(f.copied, "new-credential.txt", `github_token = "${token}"\n`);
    const rejected = await publication();
    expect(rejected.code).toBe(1);
    expect(rejected.output).toContain("PUSH BLOCKED - SECRETS IN COMMITS");
    expect(await readFile(hook)).toEqual(hookBytes);
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_TEST_HOOK;
    else process.env.PAPERCLIP_TEST_HOOK = previous;
  }
}, 30_000);
