import os from "node:os";
import path from "node:path";
import type { AdapterExecutionTarget } from "./execution-target.js";

export type GitHubLauncherLocation = {
  runId: string; target: AdapterExecutionTarget | null | undefined;
};

export function githubOperationLauncherDirectory(input: GitHubLauncherLocation): string {
  // Only controller-generated run IDs may name a removable directory.
  if (!/^[a-zA-Z0-9_-]+$/.test(input.runId)) throw new Error("Invalid GitHub launcher run ID");
  if (input.target?.kind !== "remote") {
    return path.join(os.tmpdir(), "paperclip-github-runtime", input.runId);
  }
  const inPlace = input.target.transport === "ssh" && input.target.workspaceRealization?.mode === "in_place";
  const runtimeRoot = inPlace ? input.target.workspaceRealization?.runtimeRoot?.trim() : null;
  const isolatedRoot = runtimeRoot && path.posix.isAbsolute(runtimeRoot)
    ? path.posix.join(runtimeRoot, "github")
    : null;
  if (inPlace && !isolatedRoot) {
    throw new Error("Missing isolated runtime root for in-place GitHub launchers");
  }
  return path.posix.join(
    isolatedRoot ?? path.posix.join(input.target.remoteCwd, ".paperclip-runtime", "github"),
    input.runId,
  );
}
