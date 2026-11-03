import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "./ssh-config.js";

const exec = promisify(execFile);
const PATH_ARGUMENT_BUDGET = 32 * 1024;

export function workspacePathBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const entry of paths) {
    const size = Buffer.byteLength(entry) + 16;
    if (batch.length && bytes + size > PATH_ARGUMENT_BUDGET) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function needsWorkspacePathFile(exclude: readonly string[] = [], literal: readonly string[] = []): boolean {
  return [...exclude, ...literal].reduce((bytes, entry) => bytes + Buffer.byteLength(entry) + 32, 0)
    > PATH_ARGUMENT_BUDGET;
}

// Shell builtins read the embedded lists without an exec argument limit.
// Every output path is NUL-terminated. Pruning precedes directory reads.
export function workspacePathWalkScript(input: {
  root: string;
  exclude: readonly string[];
  literal: readonly string[];
  followSymlinks?: boolean;
  scratchPatterns?: readonly string[];
}): string {
  const literalCases = input.literal.map((entry) => shellQuote(entry)).join("|");
  const scan = input.scratchPatterns !== undefined;
  return `set -e
workspace_path_excluded() {
  ${literalCases ? `case "\${1#./}" in ${literalCases}) return 0 ;; esac` : ""}
  for workspace_pattern in ${["._*", ...input.exclude].map(shellQuote).join(" ")}; do
    workspace_candidate="$1"
    while :; do
      case "$workspace_candidate" in $workspace_pattern) return 0 ;; esac
      case "$workspace_candidate" in */*) workspace_candidate="\${workspace_candidate#*/}" ;; *) break ;; esac
    done
  done
  return 1
}
workspace_path_cycle() {
  workspace_target="$1"
  shift
  for workspace_ancestor; do
    if [ "$workspace_target" -ef "$workspace_ancestor" ]; then return 0; fi
  done
  return 1
}
workspace_path_walk() {
  if workspace_path_excluded "$1"; then return; fi
  ${scan ? `
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  if [ "$1" != . ]; then
    for workspace_pattern in ${(input.scratchPatterns ?? []).map(shellQuote).join(" ")}; do
      case "\${1##*/}" in $workspace_pattern) printf '%s\\0' "$1"; return ;; esac
    done
    if [ -e "$1/.git" ] || [ -L "$1/.git" ]; then printf '%s\\0' "$1"; return; fi
  fi` : `printf '%s\\0' "$1"
  [ -d "$1" ] ${input.followSymlinks ? "" : '&& [ ! -L "$1" ]'} || return 0`}
  ${input.followSymlinks ? 'if workspace_path_cycle "$@"; then printf \'Workspace symlink cycle: %s\\n\' "$1" >&2; return 1; fi' : ""}
  if [ ! -r "$1" ] || [ ! -x "$1" ]; then
    printf 'Cannot read workspace directory: %s\\n' "$1" >&2
    return 1
  fi
  for workspace_entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$workspace_entry" ] || [ -L "$workspace_entry" ] || continue
    workspace_path_walk "$workspace_entry" "$@" || return
  done
}
cd ${shellQuote(input.root)}
workspace_path_walk .
`;
}

export function workspaceTarScript(input: Parameters<typeof workspacePathWalkScript>[0]): string {
  return `set -e
workspace_list=$(mktemp)
trap 'rm -f "$workspace_list"' EXIT
(
${workspacePathWalkScript(input)}
) > "$workspace_list"
cd ${shellQuote(input.root)}
tar ${input.followSymlinks ? "-h " : ""}--null --no-recursion -cf - -T "$workspace_list"
`;
}

export async function localWorkspaceTarList(input: Parameters<typeof workspacePathWalkScript>[0]): Promise<{
  args: string[];
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-tar-paths-"));
  const list = path.join(directory, "paths");
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const command = exec("sh", ["-s"], { timeout: 60_000, maxBuffer: 256 * 1024 });
    let stdinError: Error | undefined;
    command.child.stdin!.on("error", (error: Error) => { stdinError = error; });
    command.child.stdin!.end(`(\n${workspacePathWalkScript(input)}\n) > ${shellQuote(list)}\n`);
    await command;
    if (stdinError) throw stdinError;
    return { args: ["--null", "--no-recursion", "-T", list], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
