import type { WorkspaceOperationRecorder } from "./workspace-operations.js";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd, timeout: 10_000 })).stdout.trim();
}
async function canonical(candidate: string) {
  return fs.realpath(candidate);
}

/** Verify both sides of a linked worktree's metadata before any Git mutation. */
export async function hasOwnLinkedWorktreeGitDirectory(worktreePath: string, repoRoot: string): Promise<boolean> {
  try {
    const root = await canonical(worktreePath);
    const marker = path.join(root, ".git");
    if (!(await fs.lstat(marker)).isFile()) return false;
    if (await canonical(await git(root, ["rev-parse", "--show-toplevel"])) !== root) return false;
    const admin = await canonical(await git(root, ["rev-parse", "--absolute-git-dir"]));
    const common = await canonical(path.resolve(repoRoot, await git(repoRoot, ["rev-parse", "--git-common-dir"])));
    if (path.dirname(admin) !== path.join(common, "worktrees")) return false;
    if (await canonical(path.resolve(admin, (await fs.readFile(path.join(admin, "commondir"), "utf8")).trim())) !== common) return false;
    return await canonical(path.resolve(admin, (await fs.readFile(path.join(admin, "gitdir"), "utf8")).trim())) === marker;
  } catch {
    return false;
  }
}

/** Recover a missing link without changing files, the index, or the branch tip.
 * If administration data is gone, preserve the full folder before reconstruction.
 * Only runtime-owned branches under the managed worktree root permit reconstruction.
 */
async function repairMissingManagedWorktreeGitInner(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  runtimeOwned: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<string[]> {
  const root = await canonical(input.worktreePath);
  const marker = path.join(root, ".git");
  const markerStat = await fs.lstat(marker).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (markerStat) return [];
  const common = await canonical(path.resolve(input.repoRoot, await git(input.repoRoot, ["rev-parse", "--git-common-dir"])));
  const admins = path.join(common, "worktrees");
  const candidates = await fs.readdir(admins, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const matches: string[] = [];
  for (const entry of candidates) {
    if (!entry.isDirectory()) continue;
    const admin = path.join(admins, entry.name);
    try {
      const backlink = (await fs.readFile(path.join(admin, "gitdir"), "utf8")).trim();
      if (path.resolve(admin, backlink) !== marker) continue;
      if (await canonical(path.resolve(admin, (await fs.readFile(path.join(admin, "commondir"), "utf8")).trim())) !== common) continue;
      await fs.access(path.join(admin, "HEAD"));
      matches.push(admin);
    } catch { /* A partial administration directory cannot authorize repair. */ }
  }
  if (matches.length === 1) {
    // Exclusive creation preserves a marker installed by another caller.
    await fs.writeFile(marker, `gitdir: ${matches[0]}\n`, { flag: "wx" });
    return [`Restored the Git link at ${marker}. Working files and the index remain unchanged.`];
  }
  if (matches.length > 1 || !input.runtimeOwned || !input.branchName) return [];
  const managedRoot = path.join(await canonical(input.repoRoot), ".paperclip", "worktrees");
  const relative = path.relative(managedRoot, root);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return [];
  // Do not create a missing branch or detach a branch from another worktree.
  await git(input.repoRoot, ["rev-parse", "--verify", `refs/heads/${input.branchName}^{commit}`]);
  const registered = await git(input.repoRoot, ["worktree", "list", "--porcelain"]);
  if (registered.split("\n").includes(`branch refs/heads/${input.branchName}`)) return [];
  const quarantineRoot = path.join(await canonical(input.repoRoot), ".paperclip", "worktree-quarantine");
  await fs.mkdir(quarantineRoot, { recursive: true });
  const quarantineStat = await fs.lstat(quarantineRoot);
  if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) {
    throw new Error("The worktree quarantine must be a plain directory.");
  }
  const quarantine = path.join(quarantineRoot, `${path.basename(root).slice(0, 128)}-${randomUUID()}`);
  await fs.rename(root, quarantine);
  try {
    await git(input.repoRoot, ["worktree", "add", root, input.branchName]);
  } catch (error) {
    throw new Error(`Git worktree reconstruction failed. Original files remain at "${quarantine}".`, { cause: error });
  }
  return [`Reconstructed the Git worktree at ${root}. Original files remain at ${quarantine}.`];
}

export async function repairMissingManagedWorktreeGit(input: Parameters<typeof repairMissingManagedWorktreeGitInner>[0]): Promise<string[]> {
  // Use the restore lock so a late restore cannot race metadata recovery.
  try {
    if (await fs.lstat(path.join(input.worktreePath, ".git")).catch(() => null)) return [];
    const repair = () => withDirectoryMergeLock(input.worktreePath, (canonicalTargetDir) =>
      repairMissingManagedWorktreeGitInner({ ...input, worktreePath: canonicalTargetDir }));
    if (!input.recorder) return await repair();
    let warnings: string[] = [];
    await input.recorder.recordOperation({
      phase: "worktree_prepare", cwd: input.repoRoot,
      metadata: { worktreePath: input.worktreePath, branchName: input.branchName, repair: "missing_git_metadata" },
      run: async () => {
        warnings = await repair();
        return { status: "succeeded", exitCode: 0, system: warnings.join("\n") || null };
      },
    });
    return warnings;
  } catch (error) {
    const failure = new Error(error instanceof Error ? error.message : "Git metadata repair failed.", { cause: error });
    Object.assign(failure, {
      code: "workspace_validation_failed",
      resultJson: { workspaceValidation: { reason: "git_worktree_not_reusable", reasonCode: "git_metadata_repair_failed",
        worktreePath: input.worktreePath, expectedBranch: input.branchName } },
    });
    throw failure;
  }
}
