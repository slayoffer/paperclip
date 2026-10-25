import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

export const DEFAULT_CODEX_COMMAND = "codex";

type CommandInput = {
  runId: string;
  command: string;
  target: AdapterExecutionTarget | null | undefined;
  cwd: string;
  env: Record<string, string>;
  onLog: AdapterExecutionContext["onLog"];
};

async function commandIsMissing(input: CommandInput, command: string): Promise<boolean> {
  if (input.target?.kind === "remote") {
    const quoted = `'${command.replace(/'/g, `'"'"'`)}'`;
    // The probe never executes the configured command. Existing paths retain
    // their normal launch failures, including missing execute permissions.
    const exists = (file: string) => `[ -e ${file} ] || [ -L ${file} ]`;
    const existingPath = command.includes("/")
      ? exists(quoted)
      : `( IFS=:; for paperclip_dir in $PATH; do if ${exists(`"\${paperclip_dir:-.}"/${quoted}`)}; then exit 0; fi; done; exit 1 )`;
    const probe = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `if command -v ${quoted} >/dev/null 2>&1 || ${existingPath}; then printf '\\npaperclip-command-present\\n'; else printf '\\npaperclip-command-missing\\n'; fi`,
      { cwd: input.cwd, env: input.env, timeoutSec: 15, graceSec: 5 },
    );
    if (probe.timedOut || probe.signal || probe.exitCode !== 0) {
      throw new Error(`Cannot check Codex command ${JSON.stringify(command)} in the execution environment.`);
    }
    const marker = probe.stdout.trim().split(/\r?\n/).at(-1);
    if (marker === "paperclip-command-present") return false;
    if (marker === "paperclip-command-missing") return true;
    throw new Error(`Invalid availability response for Codex command ${JSON.stringify(command)}.`);
  }

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, input.target, input.cwd, input.env);
    return false;
  } catch (error) {
    // These errors come from the local resolver. Transport and other errors
    // must never select a different command.
    if (error instanceof Error && (
      error.message === `Command not found in PATH: "${command}"`
      || error.message.startsWith(`Command is not executable: "${command}" (resolved: "`)
    )) {
      const candidates = command.includes("/") || command.includes("\\")
        ? [path.resolve(input.cwd, command)]
        : (input.env.PATH ?? input.env.Path ?? "").split(path.delimiter)
          .filter(Boolean).map((dir) => path.resolve(input.cwd, dir, command));
      for (const candidate of candidates) {
        try {
          await lstat(candidate);
          return false;
        } catch (statError) {
          const code = (statError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw statError;
        }
      }
      return true;
    }
    throw error;
  }
}

export async function resolveCodexCommand(input: CommandInput): Promise<string> {
  if (input.command === DEFAULT_CODEX_COMMAND) {
    await ensureAdapterExecutionTargetCommandResolvable(input.command, input.target, input.cwd, input.env);
    return input.command;
  }
  if (!(await commandIsMissing(input, input.command))) return input.command;
  if (await commandIsMissing(input, DEFAULT_CODEX_COMMAND)) {
    throw new Error(
      `Configured command ${JSON.stringify(input.command)} and adapter default "codex" are missing in the execution environment.`,
    );
  }
  await input.onLog(
    "stderr",
    `[paperclip] Warning: Configured command ${JSON.stringify(input.command)} is missing in the execution environment. Using adapter default "codex".\n`,
  );
  return DEFAULT_CODEX_COMMAND;
}
