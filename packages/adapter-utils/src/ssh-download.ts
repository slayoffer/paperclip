import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline, type Transform } from "node:stream";
import { createSshAuthArgs, shellQuote } from "./ssh-auth.js";
import type { SshConnectionConfig } from "./ssh.js";

export async function streamSshToLocalFile(input: {
  spec: SshConnectionConfig;
  remoteScript: string;
  localFile: string;
  progress?: { counter: Transform };
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", [
        ...auth.args, "-p", String(input.spec.port),
        `${input.spec.username}@${input.spec.host}`,
        `sh -c ${shellQuote(input.remoteScript)}`,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const sink = createWriteStream(input.localFile, { mode: 0o600 });
      let stderr = "";
      let settled = false;
      let sshClosed = false;
      let sinkFinished = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.kill("SIGTERM");
        sink.destroy();
        reject(error);
      };
      const complete = () => {
        if (settled || !sshClosed || !sinkFinished) return;
        settled = true;
        resolve();
      };
      ssh.stderr.on("data", (chunk) => { stderr += String(chunk); });
      ssh.on("error", fail);
      sink.on("error", fail);
      ssh.on("close", (code) => {
        if (code !== 0) {
          fail(new Error(stderr.trim() || `ssh exited with code ${code ?? -1}`));
          return;
        }
        sshClosed = true;
        complete();
      });
      // Pipeline owns stream termination. A process close cannot end buffered writes.
      const onPipeComplete = (error: NodeJS.ErrnoException | null) => {
        if (error) { fail(error); return; }
        sinkFinished = true;
        complete();
      };
      if (input.progress) pipeline(ssh.stdout, input.progress.counter, sink, onPipeComplete);
      else pipeline(ssh.stdout, sink, onPipeComplete);
    });
  } finally {
    await auth.cleanup();
  }
}
