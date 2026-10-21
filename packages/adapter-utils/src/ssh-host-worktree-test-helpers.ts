import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { SshConnectionConfig, SshEnvLabFixtureState } from "./ssh-config.js";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, startSshEnvLabFixture, stopSshEnvLabFixture } from "./ssh-fixture.js";
import { hostWorktreePath, resolveHostWorktreeLayout } from "./ssh-host-worktree.js";

export const TIMEOUT_MS = 60_000;
export const REPO = "proj1234-repo";
export const EW = "ew-0001";

const cleanup: string[] = [];

export async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export async function commit(dir: string, file: string, content: string, message: string): Promise<string> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
  await git(dir, ["add", "--", file]);
  await git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message]);
  return await git(dir, ["rev-parse", "HEAD"]);
}

export async function makeServerRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-host-wt-server-"));
  cleanup.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await commit(dir, ".gitignore", "node_modules/\n", "ignore");
  await commit(dir, "a.txt", "one\n", "first");
  return dir;
}

export function hostWorktreeFixture() {
  let fixtureRoot: string | null = null;
  let fixture: SshEnvLabFixtureState | null = null;
  let baseConfig: SshConnectionConfig | null = null;
  let skipReason: string | null = null;

  let caseCounter = 0;
  function makeCase() {
    if (!fixture || !baseConfig) return null;
    caseCounter += 1;
    const basePath = path.posix.join(fixture.workspaceDir, `case-${caseCounter}`);
    const spec: SshConnectionConfig = { ...baseConfig, remoteWorkspacePath: basePath };
    const layout = resolveHostWorktreeLayout(basePath);
    const target = { spec, layout, repoKey: REPO, worktreeName: "SYNA-1-ew000001" };
    return { spec, layout, target, worktree: hostWorktreePath(layout, REPO, target.worktreeName) };
  }

  beforeAll(async () => {
    const support = await getSshEnvLabSupport();
    if (!support.supported) {
      skipReason = support.reason;
      return;
    }
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-host-wt-fixture-"));
    try {
      fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
      baseConfig = await buildSshEnvLabFixtureConfig(fixture);
    } catch (error) {
      skipReason = error instanceof Error ? error.message : String(error);
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (fixture) await stopSshEnvLabFixture(fixture).catch(() => undefined);
    for (const dir of [...cleanup, ...(fixtureRoot ? [fixtureRoot] : [])]) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function skipped(label: string): boolean {
    if (fixture) return false;
    console.warn(`Skipping ${label}: ${skipReason ?? "fixture not started"}`);
    return true;
  }

  return { makeCase, skipped };
}
