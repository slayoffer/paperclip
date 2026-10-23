import fs from "node:fs/promises";
import path from "node:path";

/** Copy provider transcripts only. Never copy authentication or configuration. */
export async function copyLegacyRestartProviderState(source: string, destination: string, adapterType: string) {
  const directories = adapterType === "codex_local" ? ["sessions", "archived_sessions"] : ["projects"];
  const sourceRoot = await fs.lstat(source).catch(() => null);
  const primary = await fs.lstat(path.join(source, directories[0]!)).catch(() => null);
  if (!sourceRoot?.isDirectory() || !primary?.isDirectory()) throw new Error("restart_provider_state_missing");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(destination)).isDirectory()) throw new Error("restart_provider_state_unsafe");
  for (const directory of directories) {
    const from = path.join(source, directory);
    if (!(await fs.lstat(from).catch(() => null))) continue;
    await fs.cp(from, path.join(destination, directory), {
      recursive: true,
      force: true,
      filter: async (file, target) => {
        const stat = await fs.lstat(file);
        const existing = await fs.lstat(target).catch(() => null);
        if (stat.isSymbolicLink() || existing?.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
          throw new Error("restart_provider_state_unsafe");
        }
        return true;
      },
    });
  }
}
