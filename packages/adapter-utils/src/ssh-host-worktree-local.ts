import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GIT_SYNC_COMMIT_IDENTITY_ARGS, runLocalGit } from "./git-workspace-sync.js";
import { HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES, HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS } from "./ssh-host-worktree-scripts.js";
import { HostWorktreeError } from "./ssh-host-worktree-lock.js";

// Local (server-side) git helpers for persistent SSH host worktrees (SYNA-2273).

export async function runGitWithInput(localDir: string, args: string[], input: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", localDir, ...args], { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function localCommitExists(localDir: string, sha: string): Promise<boolean> {
  return await runLocalGit(localDir, ["cat-file", "-e", `${sha}^{commit}`], { timeout: 10_000 }).then(() => true, () => false);
}

export async function filterLocalCommits(localDir: string, shas: string[]): Promise<string[]> {
  if (shas.length === 0) return [];
  const out = await runGitWithInput(localDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${shas.join("\n")}\n`);
  const present = new Set(out.split("\n").filter((line) => line.endsWith(" commit")).map((line) => line.split(" ")[0]));
  return shas.filter((sha) => present.has(sha));
}

/**
 * Snapshot the dirty state of a local (server) checkout as a commit whose
 * parent is HEAD, through a temporary index. Returns null when clean.
 */
export async function snapshotLocalWorkspaceWip(input: {
  localDir: string;
  ref?: string;
  wipMaxBytes?: number;
  message?: string;
}): Promise<{ headSha: string; wipSha: string | null }> {
  const headSha = (await runLocalGit(input.localDir, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-wip-index-"));
  const indexFile = path.join(tempDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    await runLocalGit(input.localDir, ["read-tree", headSha], { env });
    const paths = (await runLocalGit(input.localDir, [
      "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".", ...HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS,
    ], { env, maxBuffer: 16 * 1024 * 1024 })).stdout;
    await runGitWithInput(input.localDir, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], paths, env);
    const tree = (await runLocalGit(input.localDir, ["write-tree"], { env })).stdout.trim();
    const headTree = (await runLocalGit(input.localDir, ["rev-parse", `${headSha}^{tree}`])).stdout.trim();
    if (tree === headTree) return { headSha, wipSha: null };

    const diff = (await runLocalGit(input.localDir, ["diff-tree", "-r", "--no-renames", headTree, tree], { maxBuffer: 16 * 1024 * 1024 })).stdout;
    const changed = diff.split("\n").filter(Boolean).flatMap((line) => {
      const [meta = "", filePath = ""] = line.split("\t");
      const fields = meta.split(" ");
      return fields[4] !== "D" && fields[1] !== "160000" ? [`${fields[3]} ${filePath}`] : [];
    });
    const sizes = changed.length === 0 ? [] : (await runGitWithInput(input.localDir, ["cat-file", "--batch-check=%(objectsize) %(rest)"], `${changed.join("\n")}\n`))
      .split("\n").filter(Boolean).map((line) => {
        const space = line.indexOf(" ");
        return { size: Number(line.slice(0, space)) || 0, path: line.slice(space + 1) };
      });
    const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
    const cap = input.wipMaxBytes ?? HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES;
    if (total > cap) {
      const top = sizes.sort((a, b) => b.size - a.size).slice(0, 10).map((entry) => `${entry.size} ${entry.path}`);
      throw new HostWorktreeError("wip_too_large", `Local WIP snapshot is too large (${total} bytes). Largest paths: ${top.join("; ")}`, [String(total), ...top]);
    }
    const wipSha = (await runLocalGit(input.localDir, [
      ...GIT_SYNC_COMMIT_IDENTITY_ARGS, "commit-tree", tree, "-p", headSha, "-m", input.message ?? "Paperclip WIP snapshot",
    ])).stdout.trim();
    if (input.ref) await runLocalGit(input.localDir, ["update-ref", input.ref, wipSha]);
    return { headSha, wipSha };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
