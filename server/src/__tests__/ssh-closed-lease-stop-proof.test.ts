import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hasRemoteTerminationReceipt } from "../services/remote-execution-termination.js";

const { runSshCommand } = vi.hoisted(() => ({ runSshCommand: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>(), runSshCommand,
}));
// Fixture authentication; the selection, the receipt and the database writes stay real.
vi.mock("../services/environment-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: async (_db: unknown, _company: unknown, environment: { config: unknown }) =>
    ({ driver: "ssh", config: environment.config }),
}));
const { confirmClosedSshLeaseStops } = await import("../services/ssh-in-place-termination.js");

const support = await getEmbeddedPostgresTestSupport();
const databaseTests = support.supported ? describe : describe.skip;

// Reviewer·Codex, 2026-10-31: a cancelled run's SSH lease expired before cleanup ran, so it never got a termination
// receipt, and the agent's pause waited for that receipt forever.
databaseTests("stop proof for SSH leases that closed before cleanup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const config = { host: "10.0.0.1", port: 22, username: "worker", remoteWorkspacePath: "/home/worker/work" };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-ssh-closed-lease-");
    db = createDb(database.connectionString);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ssh-closed-lease-")));
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await rm(root, { recursive: true, force: true }); });

  async function fixture(runStatus: string, leaseStatus: string, finishedAt = new Date()) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SSH", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "codex_local" });
    const [environment] = await db.insert(environments).values({ name: `host-${randomUUID()}`, driver: "ssh", config }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: runStatus,
      invocationSource: "on_demand", startedAt: new Date(), finishedAt }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment.id,
      heartbeatRunId: run.id, provider: "ssh", status: leaseStatus, releasedAt: new Date(),
      providerLeaseId: `ssh://${config.username}@${config.host}:${config.port}${config.remoteWorkspacePath}`,
      metadata: { remoteCwd: config.remoteWorkspacePath, remoteWorkspacePath: config.remoteWorkspacePath,
        sshInPlaceWriter: { key: root, remoteCwd: config.remoteWorkspacePath } } }).returning();
    return { agentId, lease };
  }
  const read = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;

  it("writes the receipt for an expired lease of a cancelled run when the probe confirms the stop", async () => {
    runSshCommand.mockReset().mockResolvedValue({ stdout: "stopped\n", stderr: "", exitCode: 0 });
    const { agentId, lease } = await fixture("cancelled", "expired");
    expect(await confirmClosedSshLeaseStops(db, [agentId])).toBe(1);
    const row = await read(lease.id);
    expect(row).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(hasRemoteTerminationReceipt(row as never)).toBe(true);
  });

  it("writes nothing when the probe cannot confirm the stop", async () => {
    runSshCommand.mockReset().mockResolvedValue({ stdout: "running\n", stderr: "", exitCode: 0 });
    const { agentId, lease } = await fixture("cancelled", "expired");
    expect(await confirmClosedSshLeaseStops(db, [agentId])).toBe(0);
    expect((await read(lease.id)).metadata).not.toHaveProperty("remoteExecutionTermination");
  });

  it("probes neither finished runs that were not cancelled nor cancels from before the pause", async () => {
    runSshCommand.mockReset().mockResolvedValue({ stdout: "stopped\n", stderr: "", exitCode: 0 });
    const succeeded = await fixture("succeeded", "expired");
    const old = await fixture("cancelled", "expired", new Date(Date.now() - 60_000));
    expect(await confirmClosedSshLeaseStops(db, [succeeded.agentId])).toBe(0);
    expect(await confirmClosedSshLeaseStops(db, [old.agentId], new Date(Date.now() - 1_000))).toBe(0);
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
