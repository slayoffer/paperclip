import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import { type RuntimeProgressSink } from "./runtime-progress.js";
import { type SshConnectionConfig, type SshRemoteExecutionSpec, shellQuote } from "./ssh-config.js";
import { createSshAuthArgs, runSshScript } from "./ssh-command.js";
import { createSshTransferStopper } from "./ssh-transfer-stop.js";
import { tarExcludeArgs, tarSpawnEnv, estimateLocalDirSize, probeRemoteDirSize, createTransferProgress } from "./ssh-transfer-progress.js";

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir);
  await Promise.all(entries.map(async (entry) => {
    await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }));
}

export async function clearRemoteDirectory(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  preserveEntries?: string[];
}): Promise<void> {
  const preservePatterns = (input.preserveEntries ?? [])
    .map((entry) => `! -name ${shellQuote(entry)}`)
    .join(" ");
  const script = [
    "set -e",
    `mkdir -p ${shellQuote(input.remoteDir)}`,
    `find ${shellQuote(input.remoteDir)} -mindepth 1 -maxdepth 1 ${preservePatterns} -exec rm -rf -- {} +`,
  ].join("\n");
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

export async function removeDeletedPathsOnSsh(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  const script = `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
  await runSshScript(input.spec, script, {
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

export async function syncDirectoryToSsh(input: {
  spec: SshRemoteExecutionSpec;
  localDir: string;
  remoteDir: string;
  exclude?: string[];
  literalExclude?: string[];
  followSymlinks?: boolean;
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(`mkdir -p ${shellQuote(input.remoteDir)} && tar -xf - -C ${shellQuote(input.remoteDir)}`)}`,
  ];

  // tar's archive size isn't known until tar finishes, so estimate it from the
  // local file sizes and clamp the reported percent to 99% until the pipe closes.
  // The estimate walk runs concurrently with the transfer so it never delays the
  // pipe from opening on large workspaces.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Syncing",
      direction: "to",
      label: input.progressLabel,
      totalBytes: estimateLocalDirSize({
        localDir: input.localDir,
        exclude: input.exclude,
        literalExclude: input.literalExclude,
        followSymlinks: input.followSymlinks,
      }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
    const tarArgs = [
      ...(input.followSymlinks ? ["-h"] : []),
      "-C",
      input.localDir,
      ...tarExcludeArgs(input.exclude, input.literalExclude),
      "-cf",
      "-",
      ".",
    ];
    const tar = spawn("tar", tarArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: tarSpawnEnv(),
    });
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stopChildren = createSshTransferStopper([tar, ssh]);

    let tarStderr = "";
    let sshStderr = "";
    let settled = false;
    let tarExited = false;
    let sshExited = false;
    let tarExitCode: number | null = null;
    let sshExitCode: number | null = null;

    const maybeFinish = () => {
      if (settled || !tarExited || !sshExited) {
        return;
      }
      settled = true;
      if ((tarExitCode ?? 0) !== 0) {
        reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
        return;
      }
      if ((sshExitCode ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
        return;
      }
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      tar.stdout?.destroy();
      progress?.counter.destroy();
      ssh.stdin?.destroy();
      void stopChildren().then(() => reject(error), reject);
    };

    // Child process errors do not include errors from their stdio streams.
    tar.stdout?.on("error", fail);
    ssh.stdin?.on("error", fail);
    if (progress) {
      progress.counter.on("error", fail);
      tar.stdout?.pipe(progress.counter).pipe(ssh.stdin ?? null);
    } else {
      tar.stdout?.pipe(ssh.stdin ?? null);
    }
    tar.stderr?.on("data", (chunk) => {
      tarStderr += String(chunk);
    });
    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });

    tar.on("error", fail);
    ssh.on("error", fail);
    tar.on("close", (code) => {
      tarExited = true;
      tarExitCode = code;
      maybeFinish();
    });
    ssh.on("close", (code) => {
      sshExited = true;
      sshExitCode = code;
      maybeFinish();
    });
    }).finally(auth.cleanup);
    await progress?.finish();
  } catch (error) {
    await progress?.fail();
    throw error;
  }
}

export async function syncDirectoryFromSsh(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
  localDir: string;
  exclude?: string[];
  literalExclude?: string[];
  preserveLocalEntries?: string[];
  onProgress?: RuntimeProgressSink;
  progressLabel?: string;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sync-back-"));
  const remoteTarScript = [
    `cd ${shellQuote(input.remoteDir)}`,
    `tar ${[...tarExcludeArgs(input.exclude, input.literalExclude).map(shellQuote), "-cf", "-", "."].join(" ")}`,
  ].join(" && ");
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(remoteTarScript)}`,
  ];

  // The remote tar size isn't known locally, so probe the remote directory for
  // an estimate (clamped to 99%). The probe runs concurrently with the transfer
  // so its round-trip never delays the restore; when it is unavailable we report
  // bytes received in MB mode with a terminal completion line.
  const progress = input.onProgress
    ? createTransferProgress({
      onProgress: input.onProgress,
      phase: "Restoring",
      direction: "from",
      label: input.progressLabel,
      totalBytes: probeRemoteDirSize({ spec: input.spec, remoteDir: input.remoteDir }),
      estimated: true,
    })
    : null;

  try {
    await new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-xf", "-", "-C", stagingDir], {
        stdio: ["pipe", "ignore", "pipe"],
        env: tarSpawnEnv(),
      });
      const stopChildren = createSshTransferStopper([ssh, tar]);

      let sshStderr = "";
      let tarStderr = "";
      let settled = false;
      let sshExited = false;
      let tarExited = false;
      let sshExitCode: number | null = null;
      let tarExitCode: number | null = null;

      const maybeFinish = () => {
        if (settled || !sshExited || !tarExited) return;
        settled = true;
        if ((sshExitCode ?? 0) !== 0) {
          reject(new Error(sshStderr.trim() || `ssh exited with code ${sshExitCode ?? -1}`));
          return;
        }
        if ((tarExitCode ?? 0) !== 0) {
          reject(new Error(tarStderr.trim() || `tar exited with code ${tarExitCode ?? -1}`));
          return;
        }
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ssh.stdout?.destroy();
        progress?.counter.destroy();
        tar.stdin?.destroy();
        void stopChildren().then(() => reject(error), reject);
      };

      ssh.stdout?.on("error", fail);
      tar.stdin?.on("error", fail);
      if (progress) {
        progress.counter.on("error", fail);
        ssh.stdout?.pipe(progress.counter).pipe(tar.stdin ?? null);
      } else {
        ssh.stdout?.pipe(tar.stdin ?? null);
      }
      ssh.stderr?.on("data", (chunk) => {
        sshStderr += String(chunk);
      });
      tar.stderr?.on("data", (chunk) => {
        tarStderr += String(chunk);
      });

      ssh.on("error", fail);
      tar.on("error", fail);
      ssh.on("close", (code) => {
        sshExited = true;
        sshExitCode = code;
        maybeFinish();
      });
      tar.on("close", (code) => {
        tarExited = true;
        tarExitCode = code;
        maybeFinish();
      });
    });
    await progress?.finish();

    await fs.mkdir(input.localDir, { recursive: true });
    if ((await fs.readdir(input.localDir)).length === 0) {
      // Managed restores use an empty staging target. Avoid a second manifest and fsync pass.
      await copyDirectoryContents(stagingDir, input.localDir);
    } else {
      const baseline = await captureDirectorySnapshot(input.localDir, {
        exclude: [...(input.exclude ?? []), ...(input.preserveLocalEntries ?? [])],
        ignoredPaths: input.literalExclude,
      });
      await mergeDirectoryWithBaseline({ baseline, sourceDir: stagingDir, targetDir: input.localDir });
    }
  } catch (error) {
    await progress?.fail();
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await auth.cleanup();
  }
}
