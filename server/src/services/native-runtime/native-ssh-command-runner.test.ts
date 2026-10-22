import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeSshCommandRunner } from "./native-ssh-command-runner.js";
import { MAX_REMOTE_DELIVERABLE_BYTES, readVerifiedRemoteWorkspaceFile } from "./remote-deliverable-file.js";

describe("native SSH deliverable output budget", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-ssh-output-"));
    // Exercise the real SSH adapter and its output limit. Return fixture bytes
    // only for the file-read command. Execute environment setup and cleanup
    // through a local shell so those commands produce their normal output.
    const executable = join(root, "ssh");
    await writeFile(executable, `#!${process.execPath}
const command = process.argv.at(-1);
if (command.includes('paperclip_runner_file_handoff_')) {
  process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(root, "response"))}));
} else {
  const result = require('node:child_process').spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
    await chmod(executable, 0o700);
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const createRunner = () => createNativeSshCommandRunner({
    spec: {
      host: "fixture.invalid", port: 22, username: "fixture",
      remoteWorkspacePath: root, remoteCwd: root,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
    defaultCwd: root,
  });

  it.each([64, MAX_REMOTE_DELIVERABLE_BYTES])("returns exact verified bytes for a %i-byte file through the SSH adapter", async (byteSize) => {
    const body = Buffer.alloc(byteSize, 65);
    await writeFile(join(root, "response"), body.toString("base64"));
    const runner = createRunner();
    const result = await readVerifiedRemoteWorkspaceFile({
      runner, workspaceRoot: root, contentRef: "result.md",
      byteSize, sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(result.equals(body)).toBe(true);
  });

  it("stops a remote command that exceeds the maximum encoded envelope", async () => {
    await writeFile(join(root, "response"), Buffer.alloc(4 * Math.ceil(MAX_REMOTE_DELIVERABLE_BYTES / 3) + 1, 65));
    const result = await createRunner().execute({ command: "cat", args: [join(root, "response")], timeoutMs: 10_000 });
    expect(result.exitCode).not.toBe(0);
  });
});
