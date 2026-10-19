import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SshConnectionConfig } from "./ssh.js";

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function withTempFile(
  prefix: string,
  contents: string,
  mode: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, "payload");
  const normalizedContents = contents.endsWith("\n") ? contents : `${contents}\n`;
  await fs.writeFile(filePath, normalizedContents, { mode, encoding: "utf8" });
  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function createSshAuthArgs(
  config: Pick<SshConnectionConfig, "privateKey" | "knownHosts" | "strictHostKeyChecking">,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const tempFiles: Array<() => Promise<void>> = [];
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `StrictHostKeyChecking=${config.strictHostKeyChecking ? "yes" : "no"}`,
  ];

  if (config.strictHostKeyChecking) {
    if (config.knownHosts) {
      const knownHosts = await withTempFile("paperclip-ssh-known-hosts-", config.knownHosts, 0o600);
      tempFiles.push(knownHosts.cleanup);
      sshArgs.push("-o", `UserKnownHostsFile=${knownHosts.path}`);
    }
  } else {
    sshArgs.push("-o", "UserKnownHostsFile=/dev/null");
  }

  if (config.privateKey) {
    const privateKey = await withTempFile("paperclip-ssh-key-", config.privateKey, 0o600);
    tempFiles.push(privateKey.cleanup);
    sshArgs.push("-i", privateKey.path);
  }

  return {
    args: sshArgs,
    cleanup: async () => {
      await Promise.all(tempFiles.map((cleanup) => cleanup()));
    },
  };
}
