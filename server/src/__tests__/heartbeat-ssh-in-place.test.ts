import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import {
  canonicalSshInPlaceLockKey,
  readSshInPlaceWorktreeLockHolder,
  SSH_IN_PLACE_ENVIRONMENTS_ENV,
  SSH_IN_PLACE_LOCK_WAIT_MS_ENV,
} from "../services/ssh-in-place-workspace.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";

const execFileAsync = promisify(execFile);

// Emulate a same-host SSH environment: every SSH command runs with local bash,
// so the "host" sees the server's disk at the same absolute paths.
const sshCommands = vi.hoisted(() => [] as string[]);
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify: promisifyFn } = await import("node:util");
  const run = promisifyFn(execFileCb);
  return {
    ...actual,
    ensureSshWorkspaceReady: async (config: { remoteWorkspacePath: string }) => ({
      remoteCwd: config.remoteWorkspacePath,
    }),
    runSshCommand: async (_config: unknown, command: string) => {
      sshCommands.push(command);
      const { stdout, stderr } = await run("bash", ["-c", command]);
      return { stdout, stderr };
    },
    // Commands that the run sends through the target runner (for example the
    // Git context probe) also run locally, in the cwd the run asks for.
    createSshCommandManagedRuntimeRunner: (input: { defaultCwd?: string | null; spec: { remoteCwd: string } }) => ({
      execute: async (commandInput: {
        command: string;
        args?: string[];
        cwd?: string | null;
        env?: Record<string, string>;
      }) => {
        const startedAt = new Date().toISOString();
        try {
          const { stdout, stderr } = await run(commandInput.command, commandInput.args ?? [], {
            cwd: commandInput.cwd?.trim() || input.defaultCwd?.trim() || input.spec.remoteCwd,
            env: { ...process.env, ...(commandInput.env ?? {}) },
            maxBuffer: 8 * 1024 * 1024,
          });
          return { exitCode: 0, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof failure.code === "number" ? failure.code : 1,
            signal: null,
            timedOut: false,
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? String(error),
            pid: null,
            startedAt,
          };
        }
      },
    }),
  };
});

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "SSH in_place test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SSH in_place heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createGitRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-in-place-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function listFinalizeOperations(db: Db, runId: string) {
  return db
    .select()
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.heartbeatRunId, runId),
      eq(workspaceOperations.phase, "workspace_finalize"),
    ))
    .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt));
}

function readTarget(input: unknown) {
  const ctx = input as {
    executionTarget?: {
      kind?: string;
      transport?: string;
      remoteCwd?: string;
      spec?: { remoteCwd?: string };
      workspaceRealization?: { mode?: string; authoritativeRoot?: string; runtimeRoot?: string | null } | null;
    } | null;
    context?: Record<string, unknown>;
  };
  const workspace = (ctx.context?.paperclipWorkspace ?? {}) as Record<string, unknown>;
  return {
    target: ctx.executionTarget ?? null,
    workspaceCwd: typeof workspace.cwd === "string" ? workspace.cwd : null,
  };
}

async function seedRunTarget(db: Db, input: { repoRoot: string; remoteBase: string }) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const projectWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();
  const environmentId = randomUUID();

  await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
  });
  await db.insert(projects).values({ id: projectId, companyId, name: "SSH in_place", status: "active" });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: input.repoRoot,
    isPrimary: true,
  });
  await db.insert(environments).values({
    id: environmentId,
    companyId,
    name: `Same host ${environmentId}`,
    driver: "ssh",
    status: "active",
    config: { host: "same-host.invalid", username: "test", remoteWorkspacePath: input.remoteBase },
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    defaultEnvironmentId: environmentId,
    permissions: {},
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId,
    title: "Work in place on the shared host",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: agentId,
    identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    executionWorkspaceSettings: { mode: "isolated_workspace" },
  });
  return { companyId, issueId, agentId, environmentId };
}

async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}

describeEmbeddedPostgres("heartbeat SSH same-host in_place", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];
  const previousAllowlist = process.env[SSH_IN_PLACE_ENVIRONMENTS_ENV];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-in-place-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    if (previousAllowlist === undefined) delete process.env[SSH_IN_PLACE_ENVIRONMENTS_ENV];
    else process.env[SSH_IN_PLACE_ENVIRONMENTS_ENV] = previousAllowlist;
    sshCommands.length = 0;
    adapterExecute.mockReset();
    adapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "SSH in_place test run.",
      provider: "test",
      model: "test-model",
    }));
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issuePlanDecompositions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(workspaceOperations);
    await deleteHeartbeatRowsAfterActivityLogDrains(db);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  async function setup(flagOn: boolean) {
    const repoRoot = await createGitRepo();
    const remoteBase = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-in-place-remote-"));
    tempRoots.push(repoRoot, remoteBase);
    const seeded = await seedRunTarget(db, { repoRoot, remoteBase });
    if (flagOn) process.env[SSH_IN_PLACE_ENVIRONMENTS_ENV] = seeded.environmentId;
    else delete process.env[SSH_IN_PLACE_ENVIRONMENTS_ENV];
    return { ...seeded, repoRoot, remoteBase };
  }

  it("keeps the copy realization when the flag is off", async () => {
    const { agentId, issueId, remoteBase } = await setup(false);
    let seen: ReturnType<typeof readTarget> | null = null;
    adapterExecute.mockImplementationOnce(async (input) => {
      seen = readTarget(input);
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok", provider: "test", model: "test-model" };
    });

    const heartbeat = heartbeatService(db);
    const wake = await wakeIssue(heartbeat, agentId, issueId);
    const run = await waitForRunToFinish(heartbeat, wake!.id);

    expect({ status: run?.status, errorCode: run?.errorCode, error: run?.error }).toMatchObject({ status: "succeeded" });
    expect(seen!.target?.workspaceRealization?.mode).toBe("copy");
    expect(seen!.target?.remoteCwd).toBe(remoteBase);
    expect(seen!.target?.workspaceRealization?.runtimeRoot ?? null).toBeNull();
    expect(sshCommands.some((command) => command.includes(".paperclip-in-place-probe-"))).toBe(false);
  }, 20_000);

  it("runs in the server worktree and records workspace_finalize=succeeded", async () => {
    const { agentId, issueId, remoteBase } = await setup(true);
    let seen: ReturnType<typeof readTarget> | null = null;
    adapterExecute.mockImplementationOnce(async (input) => {
      seen = readTarget(input);
      // The agent writes directly into the server worktree.
      await writeFile(path.join(seen.workspaceCwd!, "agent-output.txt"), "done\n", "utf8");
      return { exitCode: 0, signal: null, timedOut: false, summary: "ok", provider: "test", model: "test-model" };
    });

    const heartbeat = heartbeatService(db);
    const wake = await wakeIssue(heartbeat, agentId, issueId);
    const run = await waitForRunToFinish(heartbeat, wake!.id);

    expect({ status: run?.status, errorCode: run?.errorCode, error: run?.error }).toMatchObject({ status: "succeeded" });
    const worktree = seen!.workspaceCwd!;
    expect(seen!.target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: worktree,
      workspaceRealization: {
        mode: "in_place",
        authoritativeRoot: worktree,
        runtimeRoot: path.posix.join(remoteBase, ".paperclip-runtime", "runs", wake!.id),
      },
    });
    // No copy: the run folder for a copy never appears under the base path.
    expect(await readdir(remoteBase)).not.toContain(".paperclip-runtime");
    // The probe file is gone, the agent file stays.
    const entries = await readdir(worktree);
    expect(entries).toContain("agent-output.txt");
    expect(entries.filter((name) => name.startsWith(".paperclip-in-place-probe-"))).toEqual([]);

    const finalize = await listFinalizeOperations(db, wake!.id);
    expect(finalize.map((operation) => operation.status)).toEqual(["succeeded"]);
    // The lease release frees the worktree lock.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))).toBeNull();
  }, 20_000);

  it("records workspace_finalize=failed when the in_place run fails", async () => {
    const { agentId, issueId } = await setup(true);
    let worktree: string | null = null;
    adapterExecute.mockImplementationOnce(async (input) => {
      const seen = readTarget(input);
      expect(seen.target?.workspaceRealization?.mode).toBe("in_place");
      worktree = seen.workspaceCwd;
      throw new Error("adapter crashed in place");
    });

    const heartbeat = heartbeatService(db);
    const wake = await wakeIssue(heartbeat, agentId, issueId);
    const run = await waitForRunToFinish(heartbeat, wake!.id);

    expect({ status: run?.status, errorCode: run?.errorCode, error: run?.error }).toMatchObject({ status: "failed" });
    const finalize = await listFinalizeOperations(db, wake!.id);
    expect(finalize.map((operation) => operation.status)).toEqual(["failed"]);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree!))).toBeNull();
  }, 20_000);

  it("gives a second concurrent lease on the same worktree the copy mode, then in_place after release", async () => {
    const { companyId, agentId, environmentId, remoteBase } = await setup(true);
    process.env[SSH_IN_PLACE_LOCK_WAIT_MS_ENV] = "300";
    try {
      const worktree = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-in-place-shared-"));
      tempRoots.push(worktree);
      const environment = await db.select().from(environments).where(eq(environments.id, environmentId))
        .then((rows) => rows[0]!);
      const runtime = environmentRuntimeService(db);
      const runIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of runIds) {
        await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "manual", status: "running" });
      }
      const realize = async (runId: string) => {
        const acquired = await runtime.acquireRunLease({
          companyId,
          environment,
          issueId: null,
          heartbeatRunId: runId,
          persistedExecutionWorkspace: null,
        });
        const realized = await runtime.realizeWorkspace({
          environment,
          lease: acquired.lease,
          workspace: {
            localPath: worktree,
            remotePath: remoteBase,
            metadata: { workspaceRealizationRequest: { adapterType: "codex_local", heartbeatRunId: runId } },
          },
        });
        return { lease: acquired.lease, realization: realized.metadata?.workspaceRealization as Record<string, unknown> };
      };

      const first = await realize(runIds[0]!);
      expect(first.realization).toMatchObject({ mode: "in_place", authoritativeRoot: worktree });

      const second = await realize(runIds[1]!);
      expect(second.realization.mode).toBe("copy");
      expect(second.realization.runtimeRoot).toBeUndefined();

      // A lease that ends outside the driver (for example a reaper) is a stale holder.
      await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, first.lease.id));
      const third = await realize(runIds[2]!);
      expect(third.realization).toMatchObject({ mode: "in_place", authoritativeRoot: worktree });
      expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))?.leaseId).toBe(third.lease.id);

      await runtime.releaseRunLeases(runIds[2]!);
      expect(readSshInPlaceWorktreeLockHolder(await canonicalSshInPlaceLockKey(worktree))).toBeNull();
      await runtime.releaseRunLeases(runIds[1]!);
    } finally {
      delete process.env[SSH_IN_PLACE_LOCK_WAIT_MS_ENV];
    }
  }, 20_000);
});
