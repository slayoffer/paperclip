import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

/** Execute SSH commands through a local shell without a network or credentials. */
export async function useLocalSsh() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-local-ssh-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh\nfor arg do command=$arg; done\nexec /bin/sh -c "$command"\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return root;
}

export const localSshSpec = (root: string) => ({
  host: "ssh.example.test", port: 22, username: "ssh-user", remoteCwd: root,
  remoteWorkspacePath: root, privateKey: null, knownHosts: null, strictHostKeyChecking: true,
});
