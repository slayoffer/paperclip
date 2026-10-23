import { spawn } from "node:child_process";
import { createSshTransferStopper } from "./ssh-transfer-stop.js";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
} from "./runtime-progress.js";
import { type SshConnectionConfig, shellQuote } from "./ssh-config.js";
import { createSshAuthArgs, runSshScript } from "./ssh-command.js";

export function tarExcludeArgs(exclude: string[] | undefined): string[] {
  const combined = ["._*", ...(exclude ?? [])];
  return combined.flatMap((entry) => ["--exclude", entry]);
}

export function tarSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Prevent macOS bsdtar from emitting AppleDouble metadata files like ._README.md.
    COPYFILE_DISABLE: "1",
  };
}

// Converts a tar `--exclude` pattern into a regexp for the local-size estimate.
// We only need approximate fidelity here (the estimate feeds a clamped percent),
// so we support the literal names and `*`/`?` globs used in practice.
function tarPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

// Walks `localDir` summing regular-file sizes, mirroring tar's `--exclude`
// handling (plus the implicit `._*`) and `followSymlinks` so the to-ssh upload
// can report an estimated total before tar finishes producing the stream.
export async function estimateLocalDirSize(input: {
  localDir: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<number> {
  const regexes = ["._*", ...(input.exclude ?? [])].map(tarPatternToRegExp);
  const isExcluded = (relPath: string, base: string) =>
    regexes.some((regex) => regex.test(relPath) || regex.test(base));

  let total = 0;
  const walk = async (dir: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (isExcluded(entryRelative, entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = await (input.followSymlinks ? fs.stat(full) : fs.lstat(full)).catch(() => null);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await walk(full, entryRelative);
      } else if (stats.isFile()) {
        total += stats.size;
      }
    }
  };
  await walk(input.localDir, "");
  return total;
}

// Best-effort remote size probe for the from-ssh restore. `du -sk` is POSIX and
// available on the BSD/Linux remotes we target; it over-counts (block-rounded,
// includes excluded dirs) which keeps the reported percent safely below 100
// until the stream actually closes. Returns null when unavailable so the caller
// falls back to MB-received mode.
export async function probeRemoteDirSize(input: {
  spec: SshConnectionConfig;
  remoteDir: string;
}): Promise<number | null> {
  try {
    const result = await runSshScript(
      input.spec,
      `du -sk ${shellQuote(input.remoteDir)} 2>/dev/null | cut -f1`,
      { timeoutMs: 15_000, maxBuffer: 16 * 1024 },
    );
    const kilobytes = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

interface TransferProgress {
  // Backpressure-respecting counter to splice into a transport pipe.
  counter: Transform;
  // Last cumulative byte count observed by the counter.
  transferred: () => number;
  // Emit the terminal completion line. Idempotent.
  finish: () => Promise<void>;
  // Emit a terminal failure marker instead of a completion line. Idempotent.
  fail: () => Promise<void>;
}

// Wraps a throttled progress reporter behind a counting Transform so transports
// can `source.pipe(progress.counter).pipe(dest)`. When `totalBytes` is a known
// exact size (e.g. a git bundle) the reporter emits an exact percentage. When it
// is an estimate (tar upload / remote probe) we clamp the reported bytes to 99%
// of the estimate so an inaccurate total never shows a premature 100%; `finish`
// then emits the terminal 100% (or, in MB-only mode, the final MB) line.
//
// `totalBytes` may be a promise so an expensive size estimate (a local dir walk
// or a remote `du` probe) runs concurrently with the transfer instead of
// blocking the pipe from opening. Until it resolves the counter reports bytes in
// MB-only mode, then adopts the percentage once the total is known; `finish`
// awaits the estimate so the terminal 100% line is still guaranteed.
export function createTransferProgress(input: {
  onProgress: RuntimeProgressSink;
  phase: RuntimeProgressPhase;
  direction: RuntimeProgressDirection;
  label?: string;
  totalBytes: number | null | Promise<number | null>;
  estimated: boolean;
}): TransferProgress {
  const reporter = createRuntimeProgressReporter({
    sink: input.onProgress,
    phase: input.phase,
    direction: input.direction,
    label: input.label,
    target: "ssh",
  });

  let total: number | null = null;
  let cap: number | null = null;
  const applyTotal = (value: number | null) => {
    total = value != null && value > 0 ? value : null;
    cap = total != null && input.estimated ? Math.floor(total * 0.99) : null;
  };
  const totalReady: Promise<void> =
    input.totalBytes != null && typeof (input.totalBytes as Promise<number | null>).then === "function"
      ? (input.totalBytes as Promise<number | null>).then(applyTotal, () => applyTotal(null))
      : (applyTotal(input.totalBytes as number | null), Promise.resolve());

  let transferred = 0;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch(() => undefined);
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      const reported = cap != null ? Math.min(transferred, cap) : transferred;
      const totalSnapshot = total;
      enqueue(() => reporter.report(reported, totalSnapshot));
      callback(null, chunk);
    },
  });

  return {
    counter,
    transferred: () => transferred,
    finish: async () => {
      await chain.catch(() => undefined);
      await totalReady.catch(() => undefined);
      await reporter.complete(total != null ? total : transferred, total).catch(() => undefined);
    },
    fail: async () => {
      await chain.catch(() => undefined);
      await reporter.fail(transferred, total).catch(() => undefined);
    },
  };
}

export async function streamLocalFileToSsh(input: {
  spec: SshConnectionConfig;
  localFile: string;
  remoteScript: string;
  progress?: TransferProgress;
}): Promise<void> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args,
    "-p",
    String(input.spec.port),
    `${input.spec.username}@${input.spec.host}`,
    `sh -c ${shellQuote(input.remoteScript)}`,
  ];

  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(input.localFile);
    const ssh = spawn("ssh", sshArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stopChildren = createSshTransferStopper([ssh]);

    let sshStderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      input.progress?.counter.destroy();
      ssh.stdin?.destroy();
      void stopChildren().then(() => reject(error), reject);
    };

    ssh.stderr?.on("data", (chunk) => {
      sshStderr += String(chunk);
    });
    source.on("error", fail);
    ssh.on("error", fail);
    ssh.stdin?.on("error", fail);
    if (input.progress) {
      input.progress.counter.on("error", fail);
      source.pipe(input.progress.counter).pipe(ssh.stdin ?? null);
    } else {
      source.pipe(ssh.stdin ?? null);
    }
    ssh.on("close", (code) => {
      if (settled) return;
      settled = true;
      if ((code ?? 0) !== 0) {
        reject(new Error(sshStderr.trim() || `ssh exited with code ${code ?? -1}`));
        return;
      }
      resolve();
    });
  }).finally(auth.cleanup);
}

export { streamSshToLocalFile } from "./ssh-download.js";
