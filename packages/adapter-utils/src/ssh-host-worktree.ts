import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMissingGitPrerequisiteError, runLocalGit } from "./git-workspace-sync.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import { createSshAuthArgs } from "./ssh-command.js";
import { type SshConnectionConfig, shellQuote } from "./ssh-config.js";
import {
  HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES,
  HOST_WORKTREE_MARKER_EXPORT,
  HOST_WORKTREE_MARKER_INSPECT,
  HOST_WORKTREE_MARKER_MATERIALIZE,
  HOST_WORKTREE_MARKER_REMOVE,
  type HostWorktreeLayout,
  assertGitSha,
  assertHostBranchName,
  assertHostWorktreeId,
  buildHostExportPrepareScript,
  buildHostExportStreamScript,
  buildHostInspectScript,
  buildHostInventoryScript,
  buildHostMaterializeScript,
  buildHostRemoveScript,
  buildHostRunDirRemoveScript,
  hostBareRepoPath,
  hostRunDir,
  hostStatePath,
  hostWorktreePath,
} from "./ssh-host-worktree-scripts.js";
import { HostWorktreeError, type HostWorktreeState, parseHostMarker, readHostWorktreeState, runHostScript } from "./ssh-host-worktree-lock.js";
import { filterLocalCommits } from "./ssh-host-worktree-local.js";
import { importHostWorktreeReferences, type HostWorktreeReference } from "./ssh-host-worktree-refs.js";
import { createTransferProgress, streamSshToLocalFile } from "./ssh-transfer-progress.js";

// Persistent per-host git worktrees for SSH runs (SYNA-2273, PR 1).
// Git objects move as delta bundles; files never move. Nothing calls these
// primitives yet: the SSH driver wires them behind a flag in a later change.

export * from "./ssh-host-worktree-scripts.js";
export * from "./ssh-host-worktree-lock.js";
export type { HostWorktreeReference } from "./ssh-host-worktree-refs.js";
export { snapshotLocalWorkspaceWip } from "./ssh-host-worktree-local.js";

const BUNDLE_TIMEOUT_MS = 10 * 60_000;

/** Runs `script` on the host with a local file (or nothing) on stdin and returns stdout. */
async function runHostScriptWithFile(input: {
  spec: SshConnectionConfig;
  script: string;
  inputFile: string | null;
  timeoutMs?: number;
}): Promise<string> {
  const auth = await createSshAuthArgs(input.spec);
  const sshArgs = [
    ...auth.args, "-p", String(input.spec.port), `${input.spec.username}@${input.spec.host}`, `sh -c ${shellQuote(input.script)}`,
  ];
  const source = input.inputFile ? await fs.open(input.inputFile, "r") : null;
  try {
    return await new Promise<string>((resolve, reject) => {
      const ssh = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => ssh.kill("SIGTERM"), input.timeoutMs ?? BUNDLE_TIMEOUT_MS);
      ssh.stdout.on("data", (chunk) => { stdout += String(chunk); });
      ssh.stderr.on("data", (chunk) => { stderr += String(chunk); });
      ssh.on("error", reject);
      ssh.stdin.on("error", () => undefined);
      ssh.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `ssh exited with code ${code ?? -1}`));
      });
      if (source) source.createReadStream().pipe(ssh.stdin);
      else ssh.stdin.end();
    });
  } finally {
    await source?.close().catch(() => undefined);
    await auth.cleanup();
  }
}

export interface HostRepoInventory {
  bareExists: boolean;
  knownHeads: string[];
}

/** Lists `refs/paperclip/known/*` of the host bare repo in one SSH call. */
export async function inventoryHostRepo(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
}): Promise<HostRepoInventory> {
  const stdout = await runHostScript(input.spec, buildHostInventoryScript({ bareRepo: hostBareRepoPath(input.layout, input.repoKey) }));
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    bareExists: lines[0] === "bare",
    knownHeads: [...new Set(lines.slice(1).filter((line) => /^[0-9a-f]{40,64}$/.test(line)))],
  };
}

export interface MaterializeHostWorktreeResult {
  worktreePath: string;
  headSha: string;
  action: "created" | "moved";
  bundleBytes: number;
  fullBundle: boolean;
}

/**
 * Send a delta bundle of `headSha` (+ `wipSha`) `--not <host known heads>`
 * into the host bare repo, then create the worktree or move the existing
 * clean one to `headSha`. Ignored files in the worktree survive.
 */
export async function materializeHostWorktree(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
  worktreeName: string;
  localDir: string;
  headSha: string;
  branch: string | null;
  wipSha?: string | null;
  knownHeads?: string[];
  /** Reset a dirty host worktree. Only after its work was exported (adopt). */
  allowDirtyReset?: boolean;
  onProgress?: RuntimeProgressSink;
  timeoutMs?: number;
}): Promise<MaterializeHostWorktreeResult> {
  const headSha = assertGitSha("head sha", input.headSha);
  const wipSha = input.wipSha ? assertGitSha("wip sha", input.wipSha) : null;
  const branch = input.branch === null ? null : assertHostBranchName(input.branch);
  const worktreePath = hostWorktreePath(input.layout, input.repoKey, input.worktreeName);
  const bareRepo = hostBareRepoPath(input.layout, input.repoKey);
  const known = input.knownHeads ?? (await inventoryHostRepo(input)).knownHeads;
  const knownSet = new Set(known);

  const scope = `refs/paperclip/host-sync/${randomUUID()}`;
  const headRef = `${scope}/head`;
  const wipRef = wipSha ? `${scope}/wip` : null;
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-bundle-"));
  const bundlePath = path.join(bundleDir, "materialize.bundle");

  const send = async (full: boolean): Promise<{ stdout: string; bytes: number }> => {
    const needed = !knownSet.has(headSha) || (wipSha !== null && !knownSet.has(wipSha));
    let bytes = 0;
    if (needed || full) {
      const exclusions = full ? [] : await filterLocalCommits(input.localDir, known);
      try {
        await runLocalGit(input.localDir, [
          "bundle", "create", bundlePath, headRef, ...(wipRef ? [wipRef] : []), ...(exclusions.length ? ["--not", ...exclusions] : []),
        ], { timeout: BUNDLE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        bytes = (await fs.stat(bundlePath)).size;
      } catch (error) {
        // Every commit is reachable from a known head: the host has the objects.
        if (!String((error as { stderr?: unknown }).stderr ?? error).includes("empty bundle")) throw error;
      }
    }
    const progress = input.onProgress && bytes > 0
      ? createTransferProgress({ onProgress: input.onProgress, phase: "Importing git history", direction: "to", totalBytes: bytes, estimated: false })
      : null;
    const stdout = await runHostScriptWithFile({
      spec: input.spec,
      script: buildHostMaterializeScript({
        layout: input.layout, bareRepo, worktreePath, headSha, wipSha, branch,
        bundleHeadRef: headRef, bundleWipRef: wipRef, allowDirtyReset: input.allowDirtyReset === true,
      }),
      inputFile: bytes > 0 ? bundlePath : null,
      timeoutMs: input.timeoutMs,
    }).then(async (out) => { await progress?.finish(); return out; }, async (error) => { await progress?.fail(); throw error; });
    await fs.rm(bundlePath, { force: true });
    return { stdout, bytes };
  };

  try {
    await runLocalGit(input.localDir, ["update-ref", headRef, headSha]);
    if (wipRef && wipSha) await runLocalGit(input.localDir, ["update-ref", wipRef, wipSha]);
    let fullBundle = known.length === 0;
    let sent: { stdout: string; bytes: number };
    try {
      sent = await send(fullBundle);
      parseHostMarker(sent.stdout, HOST_WORKTREE_MARKER_MATERIALIZE);
    } catch (error) {
      const missing = error instanceof HostWorktreeError && error.code === "host_missing_objects";
      if (fullBundle || !(missing || isMissingGitPrerequisiteError(error))) throw error;
      fullBundle = true;
      sent = await send(true);
    }
    const [hostHead, action] = parseHostMarker(sent.stdout, HOST_WORKTREE_MARKER_MATERIALIZE);
    return { worktreePath, headSha: hostHead ?? headSha, action: action === "moved" ? "moved" : "created", bundleBytes: sent.bytes, fullBundle };
  } finally {
    await runLocalGit(input.localDir, ["update-ref", "-d", headRef]).catch(() => undefined);
    if (wipRef) await runLocalGit(input.localDir, ["update-ref", "-d", wipRef]).catch(() => undefined);
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface ExportHostWorktreeResult {
  headSha: string;
  branch: string | null;
  dirty: boolean;
  wipSha: string | null;
  bundleBytes: number;
  importedHeadRef: string;
  importedWipRef: string | null;
  references: HostWorktreeReference[];
}

/**
 * Snapshot host WIP (temporary index, size cap), stream a delta bundle of
 * HEAD + WIP `--not <startHeadSha>` back, and fetch it into
 * `<importRefPrefix>/head` and `/wip` of the local checkout. The host worktree
 * itself stays as it is.
 */
export async function exportHostWorktree(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
  worktreeName: string;
  runId: string;
  startHeadSha: string | null;
  localDir: string;
  importRefPrefix?: string;
  wipMaxBytes?: number;
  forceFullBundle?: boolean;
  onProgress?: RuntimeProgressSink;
  timeoutMs?: number;
}): Promise<ExportHostWorktreeResult> {
  const runId = assertHostWorktreeId("run id", input.runId);
  const startHeadSha = input.startHeadSha ? assertGitSha("start head sha", input.startHeadSha) : null;
  const prefix = input.importRefPrefix ?? `refs/paperclip/host-worktree/imported/${assertHostWorktreeId("repo key", input.repoKey)}/${input.worktreeName}/${runId}`;
  const runDir = hostRunDir(input.layout, runId);
  const worktreePath = hostWorktreePath(input.layout, input.repoKey, input.worktreeName);
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-host-export-"));
  const bundlePath = path.join(bundleDir, "export.bundle");

  const attempt = async (full: boolean): Promise<ExportHostWorktreeResult> => {
    const stdout = await runHostScript(input.spec, buildHostExportPrepareScript({
      worktreePath, runDir, runId, startHeadSha, wipMaxBytes: input.wipMaxBytes ?? HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES, forceFullBundle: full,
    }), input.timeoutMs ?? BUNDLE_TIMEOUT_MS);
    const [headSha = "", wipSha = "", dirty = "0", sizeText = "0", branch = ""] = parseHostMarker(stdout, HOST_WORKTREE_MARKER_EXPORT);
    assertGitSha("host head sha", headSha);
    if (wipSha) assertGitSha("host wip sha", wipSha);
    const progress = input.onProgress
      ? createTransferProgress({ onProgress: input.onProgress, phase: "Exporting git history", direction: "from", totalBytes: Number(sizeText) || null, estimated: false })
      : null;
    await streamSshToLocalFile({ spec: input.spec, remoteScript: buildHostExportStreamScript({ runDir }), localFile: bundlePath, progress: progress ?? undefined })
      .then(() => progress?.finish(), async (error) => { await progress?.fail(); throw error; });
    const bundleBytes = (await fs.stat(bundlePath)).size;
    const importedHeadRef = `${prefix}/head`;
    const importedWipRef = wipSha ? `${prefix}/wip` : null;
    const references = await importHostWorktreeReferences({
      localDir: input.localDir, bundlePath, bundleBytes, prefix, runId, headSha, wipSha, stdout,
    });
    return { headSha, branch: branch || null, dirty: dirty === "1", wipSha: wipSha || null, bundleBytes, importedHeadRef, importedWipRef, references };
  };

  try {
    try {
      return await attempt(input.forceFullBundle === true);
    } catch (error) {
      const retryable = (error instanceof HostWorktreeError && error.code === "host_export_incomplete") || isMissingGitPrerequisiteError(error);
      if (input.forceFullBundle || !retryable) throw error;
      return await attempt(true);
    }
  } finally {
    await fs.rm(bundleDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface HostWorktreeInspection {
  exists: boolean;
  headSha: string | null;
  branch: string | null;
  dirty: boolean;
}

export async function inspectHostWorktree(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
  worktreeName: string;
}): Promise<HostWorktreeInspection> {
  const worktreePath = hostWorktreePath(input.layout, input.repoKey, input.worktreeName);
  const [status, headSha = "", dirty = "0", branch = ""] = parseHostMarker(
    await runHostScript(input.spec, buildHostInspectScript({ worktreePath })), HOST_WORKTREE_MARKER_INSPECT,
  );
  if (status !== "present") return { exists: false, headSha: null, branch: null, dirty: false };
  return { exists: true, headSha: headSha || null, branch: branch || null, dirty: dirty === "1" };
}

export type AdoptHostWorktreeResult =
  | { adopted: false; reason: "no_state" | "no_worktree" | "in_sync"; state: HostWorktreeState | null }
  | { adopted: true; state: HostWorktreeState; export: ExportHostWorktreeResult };

/**
 * Export the leftover work of a crashed run before a new run touches the
 * worktree. Adopts when the state still says `running`, or when the host
 * head moved away from the recorded head.
 */
export async function adoptHostWorktree(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
  worktreeName: string;
  ewId: string;
  runId: string;
  localDir: string;
  importRefPrefix?: string;
  wipMaxBytes?: number;
  onProgress?: RuntimeProgressSink;
}): Promise<AdoptHostWorktreeResult> {
  const state = await readHostWorktreeState(input);
  if (!state) return { adopted: false, reason: "no_state", state: null };
  const inspection = await inspectHostWorktree(input);
  if (!inspection.exists) return { adopted: false, reason: "no_worktree", state };
  if (state.status !== "running" && inspection.headSha === state.headSha) {
    return { adopted: false, reason: "in_sync", state };
  }
  const exportRunId = state.runId ?? assertHostWorktreeId("run id", input.runId);
  const exported = await exportHostWorktree({
    ...input,
    runId: exportRunId,
    startHeadSha: state.headSha,
    importRefPrefix: input.importRefPrefix ?? `refs/paperclip/host-worktree/adopted/${exportRunId}`,
  });
  return { adopted: true, state, export: exported };
}

export type RemoveHostWorktreeStatus = "removed" | "absent" | "head_mismatch" | "dirty";

/** `git worktree remove --force` + prune + state file, only when head matches and the worktree is clean. */
export async function removeHostWorktree(input: {
  spec: SshConnectionConfig;
  layout: HostWorktreeLayout;
  repoKey: string;
  worktreeName: string;
  ewId: string;
  expectedHeadSha: string;
}): Promise<RemoveHostWorktreeStatus> {
  const [status] = parseHostMarker(await runHostScript(input.spec, buildHostRemoveScript({
    bareRepo: hostBareRepoPath(input.layout, input.repoKey),
    worktreePath: hostWorktreePath(input.layout, input.repoKey, input.worktreeName),
    statePath: hostStatePath(input.layout, input.ewId),
    expectedHeadSha: assertGitSha("expected head sha", input.expectedHeadSha),
  }), 120_000), HOST_WORKTREE_MARKER_REMOVE);
  if (status === "removed" || status === "absent" || status === "head_mismatch" || status === "dirty") return status;
  throw new HostWorktreeError("host_protocol_error", `Unexpected host worktree remove status: ${status}`);
}

/** Removes `runs/<runId>` (runtime assets, export scratch files). The worktree stays. */
export async function removeHostRunDir(input: { spec: SshConnectionConfig; layout: HostWorktreeLayout; runId: string }): Promise<void> {
  await runHostScript(input.spec, buildHostRunDirRemoveScript({ runDir: hostRunDir(input.layout, input.runId) }));
}
