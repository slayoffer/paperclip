import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { buildSshSpawnTarget } from "./ssh-command.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-command-"));
  roots.push(root);
  return root;
}

async function execute(remoteCwd: string, remoteWorkspacePath: string, runId?: string, exitCode = 0) {
  const marker = path.join(remoteWorkspacePath, "provider-started");
  const target = await buildSshSpawnTarget({
    spec: {
      host: "ssh.example.test",
      port: 22,
      username: "ssh-user",
      remoteCwd,
      remoteWorkspacePath,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
    command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync(process.argv[1], process.cwd()); process.exit(Number(process.argv[2]));", marker, String(exitCode)],
    env: runId ? { PAPERCLIP_RUN_ID: runId } : {},
  });
  try {
    // Execute the exact remote shell argument, without an SSH server.
    return await exec("sh", ["-c", target.args.at(-1)!]);
  } finally {
    await target.cleanup();
  }
}

it.each([undefined, "run"])("does not start the provider when cd fails (run identity: %s)", async (runId) => {
  const root = await fixture();
  const marker = path.join(root, "provider-started");
  await expect(execute(path.join(root, "unavailable"), root, runId)).rejects.toMatchObject({
    code: expect.any(Number),
    stdout: "",
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(path.join(root, ".paperclip-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not start the provider when the working directory is a file", async () => {
  const root = await fixture();
  const file = path.join(root, "file");
  await writeFile(file, "not a directory");
  await expect(execute(file, root, "run")).rejects.toMatchObject({ code: expect.any(Number) });
  await expect(readFile(path.join(root, "provider-started"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([undefined, "run"])("preserves the provider directory and exit status (run identity: %s)", async (runId) => {
  const root = await fixture();
  const cwd = path.join(root, "workspace 'quoted'");
  await mkdir(cwd);
  await expect(execute(cwd, root, runId, 23)).rejects.toMatchObject({ code: 23 });
  expect(await readFile(path.join(root, "provider-started"), "utf8")).toBe(cwd);
});
