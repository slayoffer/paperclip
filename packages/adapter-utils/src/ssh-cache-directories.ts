import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { shellQuote } from "./ssh-config.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { workspacePaths, workspacePathMatcher } from "./workspace-manifest.js";
import { captureDirectorySnapshot, type DirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);

// POSIX find and test work with both GNU tar and macOS bsdtar. NUL output
// preserves whitespace and glob characters. Pruning avoids reading cache contents.
export function taggedCacheScanScript(root: string): string {
  const names = SSH_WORKSPACE_EXCLUDES.filter((entry) => !entry.includes("/"));
  const prune = [...names, ".git", ".paperclip-runtime"].map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  return `cd ${shellQuote(root)} && find . -type d \\( ${prune} \\) -prune -o ` +
    "-type d -exec test -f '{}/CACHEDIR.TAG' \\; -print0 -prune";
}

export function parseTaggedCacheDirectories(output: string): string[] {
  return output.split("\0").filter(Boolean).map((entry) => entry === "." ? "." : entry.slice(2));
}

export async function localTaggedCacheDirectories(root: string): Promise<string[]> {
  const exists = await stat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!exists) return [];
  const { stdout } = await exec("sh", ["-c", taggedCacheScanScript(root)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseTaggedCacheDirectories(stdout);
}

export function cacheDirectoryTarExcludes(directories: string[]): string[] {
  return directories.map((entry) => (entry === "." ? "." : `./${entry}`)
    .replace(/\\/g, "\\\\").replace(/([*?[])/g, "\\$1"));
}

export async function captureSshWorkspaceSnapshot(root: string, options: { exclude: string[] }): Promise<DirectorySnapshot> {
  const ignoredPaths = await localTaggedCacheDirectories(root);
  if (ignoredPaths.includes(".")) return { exclude: options.exclude, entries: new Map() };
  return captureDirectorySnapshot(root, { ...options, ignoredPaths });
}

// SSH baselines are in-memory maps. Filter old entries as well as future scans:
// a directory can gain a tag after prepare, on either side of the transfer.
export function withTaggedCacheDirectories(
  snapshot: DirectorySnapshot, directories: string[],
): DirectorySnapshot & { ignoredPaths: string[] } {
  const ignoredPaths = [...new Set([
    ...workspacePaths(snapshot.ignoredPaths ?? []), ...directories.filter((entry) => entry !== "."),
  ])];
  const ignored = workspacePathMatcher(ignoredPaths);
  try {
    return { ...snapshot, ignoredPaths,
      entries: new Map([...snapshot.entries].filter(([relative]) => !directories.includes(".") && !ignored.matches(relative))),
    };
  } finally { ignored.close(); }
}
