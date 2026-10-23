import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => ({
  runSshCommand: vi.fn(),
  syncDirectoryToSsh: vi.fn(),
  prepareWorkspaceForSshExecution: vi.fn(),
  restoreWorkspaceFromSshExecution: vi.fn(),
}));
vi.mock("./ssh.js", () => ssh);
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([
  { adapterKey: "codex", assetKey: "home", sessionDirectory: "sessions", ownerMode: false },
  { adapterKey: "codex", assetKey: "home", sessionDirectory: "sessions", ownerMode: true },
  { adapterKey: "claude", assetKey: "config-seed", sessionDirectory: "projects", ownerMode: false },
  { adapterKey: "claude", assetKey: "config-seed", sessionDirectory: "projects", ownerMode: true },
])("preserves $adapterKey transcripts across two runs and isolates companies (owner=$ownerMode)", async ({ adapterKey, assetKey, sessionDirectory, ownerMode }) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-sessions-")));
  roots.push(root);
  const workspace = path.join(root, "worktree");
  const seed = path.join(root, "seed");
  await mkdir(workspace);
  await mkdir(seed);
  await writeFile(path.join(seed, "config.json"), "{}");
  await mkdir(path.join(seed, sessionDirectory));
  await writeFile(path.join(seed, sessionDirectory, "seed-session.jsonl"), "old company session");
  ssh.runSshCommand.mockImplementation(async (_spec, command) => execFileAsync("bash", ["-c", command]));
  ssh.syncDirectoryToSsh.mockImplementation(async ({ localDir, remoteDir, exclude = [] }) => {
    await mkdir(remoteDir, { recursive: true });
    await cp(localDir, remoteDir, { recursive: true,
      filter: (source) => !exclude.includes(path.relative(localDir, source).split(path.sep)[0]),
    });
  });
  async function prepare(runId: string, companyId = "company-a") {
    const issueWorkspace = ownerMode ? path.join(root, `worktree-${runId}`) : workspace;
    await mkdir(issueWorkspace, { recursive: true });
    return prepareRemoteManagedRuntime({
      spec: { host: "fixture", port: 22, username: "fixture", remoteCwd: root,
        remoteWorkspacePath: root, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
      runId, companyId, adapterKey, workspaceLocalDir: issueWorkspace, workspaceRemoteDir: issueWorkspace,
      syncWorkspace: false,
      providerSessionRoot: ownerMode ? path.join(root, "owner-sessions", companyId, "agent-a", "project-a", "provider-sessions") : undefined,
      runtimeRootDir: path.join(root, ".paperclip-runtime", "runs", runId, adapterKey),
      assets: [{ key: assetKey, localDir: seed }],
    });
  }
  const first = await prepare("first");
  await expect(readFile(path.join(first.assetDirs[assetKey]!, sessionDirectory, "seed-session.jsonl")))
    .rejects.toMatchObject({ code: "ENOENT" });
  const transcript = path.join(first.assetDirs[assetKey]!, sessionDirectory, "session-1.jsonl");
  await writeFile(transcript, '{"sessionId":"session-1","turn":1}\n');
  const durableTranscript = await realpath(transcript);
  expect(durableTranscript).toContain(ownerMode ? "/owner-sessions/company-a/agent-a/project-a/" : "/provider-sessions/company-a/");
  expect(durableTranscript.startsWith(`${workspace}/`)).toBe(false);
  await first.restoreWorkspace();
  await expect(readFile(first.runtimeRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(durableTranscript, "utf8")).toContain('"turn":1');

  const second = await prepare("second");
  const resumedTranscript = path.join(second.assetDirs[assetKey]!, sessionDirectory, "session-1.jsonl");
  expect(await realpath(resumedTranscript)).toBe(durableTranscript);
  // Resume reads the actual prior file through the new provider home.
  const resume = await execFileAsync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const transcript = process.argv[1];
    const first = JSON.parse(fs.readFileSync(transcript, 'utf8').trim());
    if (first.sessionId !== 'session-1') process.exit(1);
    fs.appendFileSync(transcript, JSON.stringify({ sessionId: first.sessionId, turn: 2 }) + '\\n');
    console.log('resumed session-1');
  `, resumedTranscript]);
  expect(resume.stdout.trim()).toBe("resumed session-1");
  expect(await readFile(durableTranscript, "utf8")).toContain('"turn":2');
  const otherCompany = await prepare("third", "company-b");
  await expect(readFile(path.join(otherCompany.assetDirs[assetKey]!, sessionDirectory, "session-1.jsonl")))
    .rejects.toMatchObject({ code: "ENOENT" });
  await second.restoreWorkspace();
  await otherCompany.restoreWorkspace();
  expect(ssh.prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
  expect(ssh.restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
});

it.each(["asset", "sessions"])("refuses a %s alias into the repository before upload", async (alias) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-runtime-alias-")));
  roots.push(root);
  const workspace = path.join(root, "worktree");
  const runtimeRoot = path.join(root, ".paperclip-runtime", "runs", "run", "codex");
  await mkdir(workspace);
  await mkdir(runtimeRoot, { recursive: true });
  await symlink(workspace, alias === "asset" ? path.join(runtimeRoot, "home")
    : path.join(root, ".paperclip-runtime", "provider-sessions"));
  const sentinel = path.join(workspace, "sentinel");
  await writeFile(sentinel, "repository data");
  ssh.runSshCommand.mockImplementation(async (_spec, command) => execFileAsync("bash", ["-c", command]));
  await expect(prepareRemoteManagedRuntime({
    spec: { host: "fixture", port: 22, username: "fixture", remoteCwd: root,
      remoteWorkspacePath: root, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
    runId: "run", companyId: "company-a", adapterKey: "codex",
    workspaceLocalDir: workspace, workspaceRemoteDir: workspace, syncWorkspace: false,
    runtimeRootDir: runtimeRoot, assets: [{ key: "home", localDir: workspace }],
  })).rejects.toThrow();
  expect(ssh.syncDirectoryToSsh).not.toHaveBeenCalled();
  expect(await readFile(sentinel, "utf8")).toBe("repository data");
});
