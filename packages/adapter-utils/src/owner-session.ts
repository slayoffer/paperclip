import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionTarget } from "./execution-target.js";
import { overrideAdapterExecutionTargetRemoteCwd } from "./execution-target.js";
import { runSshCommand, shellQuote } from "./ssh.js";

export interface OwnerSessionLaunch {
  cwd: string;
  target: AdapterExecutionTarget | null | undefined;
  providerSessionRoot: string | undefined;
  workspacePrompt: (workspace: string, resumed: boolean) => string;
}

/** The controller constructs this context. It never comes from an agent wake. */
export async function prepareOwnerSessionLaunch(input: {
  context: Record<string, unknown>;
  companyId: string;
  agentId: string;
  target: AdapterExecutionTarget | null | undefined;
}): Promise<OwnerSessionLaunch | null> {
  const scope = input.context.paperclipOwnerSession as Record<string, unknown> | undefined;
  if (!scope) return null;
  for (const id of [input.companyId, input.agentId, scope.projectId]) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid owner session scope");
  }
  if (input.target?.kind === "remote" && input.target.transport !== "ssh") {
    throw new Error("Owner sessions require a local or SSH environment");
  }
  const localDirectory = scope.localDirectory;
  if (typeof localDirectory !== "string" || !path.isAbsolute(localDirectory)) throw new Error("Invalid owner session directory");
  let directory: string = localDirectory;
  if (input.target?.kind === "remote") {
    const home = (await runSshCommand(input.target.spec, 'printf "%s" "$HOME"', { timeoutMs: 30_000 })).stdout.trim();
    if (!path.posix.isAbsolute(home) || home === "/") throw new Error("Invalid owner session host home");
    directory = path.posix.join(home, ".paperclip", "owner-sessions", input.companyId, input.agentId, String(scope.projectId));
    await runSshCommand(input.target.spec, `umask 077\nmkdir -p -- ${shellQuote(directory)}`, { timeoutMs: 30_000 });
  } else {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  return {
    cwd: directory,
    target: overrideAdapterExecutionTargetRemoteCwd(input.target, directory),
    providerSessionRoot: input.target?.kind === "remote" ? path.posix.join(directory, "provider-sessions") : undefined,
    workspacePrompt: (workspace, resumed) => [
      "Paperclip owner session:",
      `Current issue workspace: ${JSON.stringify(workspace)}.`,
      `Current issue branch: ${JSON.stringify((input.context.paperclipWorkspace as Record<string, unknown> | undefined)?.branchName ?? null)}.`,
      "Use this workspace for all repository commands in this turn. Read its AGENTS.md before changes.",
      "Keep the issue branch. Earlier issues and their approvals do not authorize this issue.",
      !resumed && typeof scope.handoffMarkdown === "string" ? scope.handoffMarkdown : "",
    ].filter(Boolean).join("\n"),
  };
}
