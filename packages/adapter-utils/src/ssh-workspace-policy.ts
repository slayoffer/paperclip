import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote, type SshConnectionConfig } from "./ssh-config.js";
import { runSshScript } from "./ssh-command.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

const exec = promisify(execFile);

export interface SshWorkspaceSyncPolicy {
  patterns: string[];
  excluded: Map<string, string[]>;
  logged: Set<string>;
}

export function createSshWorkspaceSyncPolicy(): SshWorkspaceSyncPolicy {
  const configured = process.env.PAPERCLIP_SSH_SCRATCH_PATTERNS;
  const patterns: unknown = configured === undefined ? [".scratch-*", ".cto-*"] : JSON.parse(configured);
  if (!Array.isArray(patterns) || patterns.some((value) =>
    typeof value !== "string" || !value || value.includes("/") || value.includes("\0"))) {
    throw new Error("PAPERCLIP_SSH_SCRATCH_PATTERNS must be a JSON array of directory name patterns");
  }
  return { patterns, excluded: new Map(), logged: new Set() };
}

// Both ends use the same POSIX tools. NUL records preserve spaces and newlines.
function scanScript(root: string, exclude: string[], patterns: string[]): string {
  const ignored = [".git", "._*", ...exclude].map((pattern) => pattern.includes("/")
    ? `-path ${shellQuote(`./${pattern}`)}` : `-name ${shellQuote(pattern)}`).join(" -o ");
  const scratch = patterns.map((pattern) => `-name ${shellQuote(pattern)} -o `).join("");
  const report = 'for entry do size=$(du -sk "$entry") || exit; size=${size%%[[:space:]]*}; printf "%s\\0%s\\0" "$entry" "$size"; done';
  return `cd ${shellQuote(root)} && find . -mindepth 1 \\( ${ignored} \\) -prune -o `
    + `-type d \\( ${scratch}-exec test -e '{}/.git' \\; -o -exec test -L '{}/.git' \\; \\) `
    + `-prune -exec sh -c ${shellQuote(report)} sh {} +`;
}

export async function sshWorkspaceExcludes(input: {
  policy: SshWorkspaceSyncPolicy;
  localDir: string;
  remote?: { spec: SshConnectionConfig; dir: string };
  exclude: string[];
  onProgress?: RuntimeProgressSink;
}): Promise<string[]> {
  const script = scanScript(input.remote?.dir ?? input.localDir, input.exclude, input.policy.patterns);
  const options = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
  const result = input.remote
    ? await runSshScript(input.remote.spec, script, { timeoutMs: options.timeout, maxBuffer: options.maxBuffer })
    : await exec("sh", ["-c", script], options);
  const entries = result.stdout.split("\0");
  const excluded = new Set(input.policy.excluded.get(input.localDir) ?? []);
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const relative = entries[index]!.slice(2);
    excluded.add(relative);
    const key = `${input.localDir}\0${relative}`;
    if (input.policy.logged.has(key)) continue;
    const message = `[paperclip] Skipped SSH workspace path ${JSON.stringify(relative)} (size=${entries[index + 1]} KiB)`;
    if (input.onProgress) await input.onProgress(message);
    else console.info(message);
    input.policy.logged.add(key);
  }
  input.policy.excluded.set(input.localDir, [...excluded]);
  return input.exclude;
}
