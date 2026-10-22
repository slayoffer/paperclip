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
    // Exercise the real SSH command adapter and its execFile output limit,
    // replacing only the network executable with a local shell. Environment
    // setup and cleanup must execute without returning the file payload.
    const executable = join(root, "ssh");
    await writeFile(executable, '#!/bin/sh\nfor arg do command=$arg; done\nexec /bin/sh -c "$command"\n');
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

  // The real reader checks Linux descriptors through /proc/self/fd.
  it.skipIf(process.platform !== "linux").each([64, MAX_REMOTE_DELIVERABLE_BYTES])("returns exact verified bytes for a %i-byte file through the SSH adapter", async (byteSize) => {
    const body = Buffer.alloc(byteSize, 65);
    await writeFile(join(root, "result.md"), body);
    const result = await readVerifiedRemoteWorkspaceFile({
      runner: createRunner(), workspaceRoot: root, contentRef: "result.md",
      byteSize, sha256: createHash("sha256").update(body).digest("hex"),
    });
    expect(result.equals(body)).toBe(true);
  });

  it("stops a remote command that exceeds the maximum encoded envelope", async () => {
    await writeFile(join(root, "response"), Buffer.alloc(4 * Math.ceil(MAX_REMOTE_DELIVERABLE_BYTES / 3) + 1, 65));
    const result = await createRunner().execute({
      command: "node", args: ["-e", "process.stdout.write(require('node:fs').readFileSync('response'))"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });
});
