import { createHash } from "node:crypto";
import path from "node:path";
import { shellQuote } from "./ssh-config.js";

export function sshProviderSessionDirectories(input: {
  runtimeRoot: string;
  providerSessionRoot?: string;
  adapterKey: string;
  companyId?: string;
  workspace: string;
  assetKeys: string[];
}): Array<{ assetKey: string; name: string; directory: string }> {
  const assetKey = input.adapterKey === "codex" ? "home"
    : input.adapterKey === "claude" ? "config-seed" : null;
  if (!assetKey || !input.assetKeys.includes(assetKey)) return [];
  if (!input.companyId || !/^[a-zA-Z0-9_-]+$/.test(input.companyId)) {
    throw new Error("SSH provider sessions require a company identity");
  }
  const workspaceKey = createHash("sha256").update(input.workspace).digest("hex");
  const root = input.providerSessionRoot ? path.posix.join(input.providerSessionRoot, input.adapterKey) : path.posix.join(input.runtimeRoot, "..", "..", "..", "provider-sessions",
    input.companyId, workspaceKey, input.adapterKey);
  const names = input.adapterKey === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  return names.map((name) => ({ assetKey, name, directory: path.posix.join(root, name) }));
}

export function linkSshProviderSessionScript(link: string, directory: string): string {
  const source = shellQuote(link);
  const target = shellQuote(directory);
  return [
    "set -eu",
    "umask 077",
    `mkdir -p -- ${target}`,
    `if [ -L ${source} ]; then`,
    `  [ "$(readlink -- ${source})" = ${target} ]`,
    `elif [ ! -e ${source} ]; then`,
    `  ln -s -- ${target} ${source}`,
    "else",
    '  echo "Provider session path already exists" >&2; exit 1',
    "fi",
  ].join("\n");
}
