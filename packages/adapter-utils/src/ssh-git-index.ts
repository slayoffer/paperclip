import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Prepare the index before moving HEAD. A two-tree merge retains staged local
// changes when they do not conflict with the incoming history. Index-only mode
// permits dirty working files without writing them or excluded directories.
export async function updateGitHeadAndIndex(
  localDir: string,
  headRef: string,
  currentHead: string,
  nextHead: string,
): Promise<void> {
  const git = (args: string[], indexFile?: string) => exec("git", ["-C", localDir, ...args], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    ...(indexFile ? { env: { ...process.env, GIT_INDEX_FILE: indexFile } } : {}),
  });
  const indexPath = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
  const lockPath = `${indexPath}.lock`;
  const stagedIndexPath = `${indexPath}.paperclip-${randomUUID()}`;
  // Hold the standard lock so ordinary Git writers cannot change the index
  // between the staged-change check and publication of the new HEAD/index.
  const lock = await fs.open(lockPath, "wx");
  try {
    try {
      await fs.copyFile(indexPath, stagedIndexPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An absent index is valid. Seed the temporary index from the old HEAD.
      await git(["read-tree", currentHead], stagedIndexPath);
    }
    await git(["read-tree", "-i", "-m", currentHead, nextHead], stagedIndexPath);
    await git(["update-ref", headRef, nextHead, currentHead]);
    await fs.rename(stagedIndexPath, indexPath);
  } finally {
    await lock.close();
    await fs.rm(stagedIndexPath, { force: true });
    await fs.rm(`${stagedIndexPath}.lock`, { force: true });
    await fs.rm(lockPath, { force: true });
  }
}
