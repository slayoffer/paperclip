import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote, type SshConnectionConfig } from "./ssh-config.js";
import { runSshCommand } from "./ssh-command.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import { workspacePaths, type WorkspacePaths } from "./workspace-manifest.js";

const exec = promisify(execFile);

export interface SshWorkspaceSyncPolicy {
  patterns: string[];
  excluded: Map<string, string[]>;
  logged: Set<string>;
  sizeTimeoutMs: number;
}

export function createSshWorkspaceSyncPolicy(): SshWorkspaceSyncPolicy {
  const configured = process.env.PAPERCLIP_SSH_SCRATCH_PATTERNS;
  const patterns: unknown = configured === undefined ? [".scratch-*", ".cto-*"] : JSON.parse(configured);
  if (!Array.isArray(patterns) || patterns.some((value) =>
    typeof value !== "string" || !value || value.includes("/") || value.includes("\0"))) {
    throw new Error("PAPERCLIP_SSH_SCRATCH_PATTERNS must be a JSON array of directory name patterns");
  }
  return { patterns, excluded: new Map(), logged: new Set(), sizeTimeoutMs: 5_000 };
}

// Both ends use the same POSIX tools. NUL records preserve spaces and newlines.
function scanScript(root: string, exclude: string[], patterns: string[], ignoredPaths?: WorkspacePaths): string {
  const ignored = [
    ...[".git", "._*", ...exclude].map((pattern) => pattern.includes("/")
      ? `-path ${shellQuote(`./${pattern}`)}` : `-name ${shellQuote(pattern)}`),
    ...[...workspacePaths(ignoredPaths ?? [])].map((relative) =>
      `-path ${shellQuote(`./${relative.replace(/([\\*?\[\]])/g, "\\$1")}`)}`),
  ].join(" -o ");
  const scratch = patterns.map((pattern) => `-name ${shellQuote(pattern)} -o `).join("");
  return `cd ${shellQuote(root)} || exit $?; [ ! -f CACHEDIR.TAG ] || exit 0; find . -mindepth 1 \\( ${ignored} \\) -prune -o `
    + `-type d -exec test -f '{}/CACHEDIR.TAG' \\; -prune -o `
    + `-type d \\( ${scratch}-exec test -e '{}/.git' \\; -o -exec test -L '{}/.git' \\; \\) `
    + `-prune -print0`;
}

async function runPolicyScript(
  script: string, timeout: number, remote?: { spec: SshConnectionConfig },
): Promise<{ stdout: string }> {
  const maxBuffer = 4 * 1024 * 1024;
  if (remote) return runSshCommand(remote.spec, "sh -s", { stdin: script, timeoutMs: timeout, maxBuffer });
  const command = exec("sh", ["-s"], { timeout, maxBuffer });
  let stdinError: Error | undefined;
  command.child.stdin!.on("error", (error: Error) => { stdinError = error; });
  command.child.stdin!.end(script);
  const result = await command;
  if (stdinError) throw stdinError;
  return result;
}

export async function sshWorkspaceExcludes(input: {
  policy: SshWorkspaceSyncPolicy;
  localDir: string;
  remote?: { spec: SshConnectionConfig; dir: string };
  exclude: string[];
  ignoredPaths?: WorkspacePaths;
  onProgress?: RuntimeProgressSink;
}): Promise<string[]> {
  if (!input.remote) {
    const exists = await stat(input.localDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!exists) return input.exclude;
  }
  const ignoredPaths = [...new Set([
    ...workspacePaths(input.ignoredPaths ?? []), ...(input.policy.excluded.get(input.localDir) ?? []),
  ])];
  const script = scanScript(input.remote?.dir ?? input.localDir, input.exclude, input.policy.patterns, ignoredPaths);
  const result = await runPolicyScript(script, 60_000, input.remote);
  const entries = result.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(2));
  input.policy.excluded.set(input.localDir, [...new Set([
    ...(input.policy.excluded.get(input.localDir) ?? []), ...entries,
  ])]);
  const pending = entries.filter((relative) => !input.policy.logged.has(`${input.localDir}\0${relative}`));
  const sizes = new Map<string, string>();
  if (pending.length > 0) {
    const sizeScript = `cd ${shellQuote(input.remote?.dir ?? input.localDir)} && `
      + `for entry in ${pending.map((entry) => shellQuote(`./${entry}`)).join(" ")}; do `
      + 'if size=$(du -sk "$entry" 2>/dev/null); then size=${size%%[[:space:]]*}; else size=unknown; fi; '
      + 'printf "%s\\0%s\\0" "$entry" "$size"; done';
    const measured = await runPolicyScript(sizeScript, input.policy.sizeTimeoutMs, input.remote).catch(() => null);
    const records = measured?.stdout.split("\0") ?? [];
    for (let index = 0; index + 1 < records.length; index += 2) {
      sizes.set(records[index]!.slice(2), records[index + 1]!);
    }
  }
  for (const relative of pending) {
    const key = `${input.localDir}\0${relative}`;
    const message = `[paperclip] Skipped SSH workspace path ${JSON.stringify(relative)} (size=${sizes.get(relative) || "unknown"} KiB)`;
    if (input.onProgress) await input.onProgress(message);
    else console.info(message);
    input.policy.logged.add(key);
  }
  return input.exclude;
}
