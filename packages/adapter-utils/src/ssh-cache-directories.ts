import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { shellQuote } from "./ssh-config.js";
import { SSH_WORKSPACE_EXCLUDES } from "./ssh-workspace-excludes.js";
import { shouldExcludePath } from "./exclude-patterns.js";
import { workspacePaths, workspacePathMatcher, type WorkspacePaths } from "./workspace-manifest.js";
import { captureDirectorySnapshot, type DirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);

// Only fixed cache names and metadata roots can enter this command. Caller
// exclusions stay in TypeScript, so a large Git ignore list cannot exceed argv.
export function taggedCacheScanScript(root: string, exclude: readonly string[] = []): string {
  // In the shared matcher, '*/' patterns exclude a segment at every depth.
  // Root-relative names must not prune nested directories with the same name.
  const globalPatterns = exclude.filter((pattern) => pattern.startsWith("*/"));
  const prune = SSH_WORKSPACE_EXCLUDES.filter((name) => !name.includes("/") && shouldExcludePath(name, globalPatterns))
    .map((name) => `-name ${shellQuote(name)}`);
  for (const relative of [".git", ".paperclip-runtime"]) {
    if (shouldExcludePath(relative, exclude)) prune.push(`-path ${shellQuote(`./${relative}`)}`);
  }
  return `cd ${shellQuote(root)} && find . ` +
    (prune.length ? `-type d \\( ${prune.join(" -o ")} \\) -prune -o ` : "") +
    "-type d -exec test -f '{}/CACHEDIR.TAG' \\; -exec printf 'T%s\\0' {} \\; -prune -o " +
    "-type d \\( ! -exec test -r {} \\; -o ! -exec test -x {} \\; \\) " +
    "-exec printf 'U%s\\0' {} \\; -prune";
}

export function parseTaggedCacheDirectories(
  output: string, exclude: readonly string[] = [], ignoredPaths?: WorkspacePaths,
): string[] {
  const ignored = workspacePathMatcher(ignoredPaths);
  const directories: string[] = [];
  try {
    for (const record of output.split("\0").filter(Boolean)) {
      const kind = record[0];
      const relative = record.slice(1) === "." ? "." : record.slice(3);
      if ((kind !== "T" && kind !== "U") || (record.slice(1) !== "." && !record.slice(1).startsWith("./"))) {
        throw new Error("Invalid cache directory scan record");
      }
      if (shouldExcludePath(relative, exclude) || ignored.matches(relative)) continue;
      if (kind === "U") throw Object.assign(new Error(`Cannot read workspace directory: ${relative}`), { code: "EACCES" });
      directories.push(relative);
    }
    return directories;
  } finally { ignored.close(); }
}

export async function localTaggedCacheDirectories(
  root: string, exclude: readonly string[] = [], ignoredPaths?: WorkspacePaths,
): Promise<string[]> {
  const exists = await stat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!exists) return [];
  const { stdout } = await exec("sh", ["-c", taggedCacheScanScript(root, exclude)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseTaggedCacheDirectories(stdout, exclude, ignoredPaths);
}

export function cacheDirectoryTarExcludes(directories: string[]): string[] {
  return directories.map((entry) => (entry === "." ? "." : `./${entry}`)
    .replace(/\\/g, "\\\\").replace(/([*?[])/g, "\\$1"));
}

export async function captureSshWorkspaceSnapshot(root: string, options: { exclude: string[] }): Promise<DirectorySnapshot> {
  const ignoredPaths = await localTaggedCacheDirectories(root, options.exclude);
  // Keep the whole-root tar exclusion in serialized baselines. A later marker
  // removal must not turn this intentionally empty snapshot into an empty tree.
  if (options.exclude.includes(".") || ignoredPaths.includes(".")) {
    return { exclude: [...new Set([...options.exclude, "."])], entries: new Map() };
  }
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
