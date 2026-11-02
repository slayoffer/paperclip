import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { shellQuote } from "./ssh-config.js";
import { parseExcludePattern, shouldExcludePath } from "./exclude-patterns.js";
import { workspacePaths, workspacePathMatcher, type WorkspacePaths } from "./workspace-manifest.js";
import { captureDirectorySnapshot, type DirectorySnapshot } from "./workspace-directory-snapshot.js";

const exec = promisify(execFile);

// Send this script through stdin, never argv. POSIX find cannot read prune
// patterns from a file; shell builtins avoid both argv limits and a process
// per directory. Compile the shared matcher's scopes, quoting literal values.
export function taggedCacheScanScript(
  root: string, exclude: readonly string[] = [], ignoredPaths?: WorkspacePaths,
): string {
  const prune = exclude.map((pattern) => {
    const { scope, value } = parseExcludePattern(pattern);
    const literal = shellQuote(value);
    if (scope === "segment") return `${literal}|${literal}/*|*/${literal}|*/${literal}/*`;
    if (scope === "descendants") return `${literal}/*`;
    return `${literal}|${literal}/*`;
  });
  for (const relative of workspacePaths(ignoredPaths ?? [])) {
    const literal = shellQuote(relative);
    prune.push(`${literal}|${literal}/*`);
  }
  return `set -e
cache_scan_excluded() {
  ${prune.length ? `case "$1" in ${prune.join("|")}) return 0 ;; esac` : ""}
  return 1
}
cache_scan_walk() {
  if cache_scan_excluded "${"${1#./}"}"; then return; fi
  if [ -f "$1/CACHEDIR.TAG" ]; then printf 'T%s\\0' "$1"; return; fi
  if [ ! -r "$1" ] || [ ! -x "$1" ]; then printf 'U%s\\0' "$1"; return; fi
  for cache_scan_entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -d "$cache_scan_entry" ] && [ ! -L "$cache_scan_entry" ] || continue
    cache_scan_walk "$cache_scan_entry" || return
  done
}
cd ${shellQuote(root)}
cache_scan_walk .
`;
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
  const script = taggedCacheScanScript(root, exclude, ignoredPaths);
  const scan = exec("sh", ["-s"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  let stdinError: Error | undefined;
  scan.child.stdin!.on("error", (error: Error) => { stdinError = error; });
  scan.child.stdin!.end(script);
  const { stdout } = await scan;
  if (stdinError) throw stdinError;
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
