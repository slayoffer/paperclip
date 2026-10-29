import { createHash, randomUUID } from "node:crypto";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { createSshEnvironmentDriver } from "../../services/environment-ssh-driver.js";
import { createSshInPlaceOwnershipReconciler } from "../../services/ssh-in-place-reconciliation.js";
import { sshInPlaceLockChecks } from "../../services/ssh-in-place-lock-checks.js";
import { confirmSshInPlaceTermination } from "../../services/ssh-in-place-termination.js";
import { acquireSshInPlaceWorktreeLock, readSshInPlaceWorktreeLockHolder,
  releaseSshInPlaceWorktreeLocksForLease } from "../../services/ssh-in-place-lock.js";
import { hasRemoteTerminationReceipt } from "../../services/remote-execution-termination.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "../../services/workspace-realization.js";

type Owner = {
  companyId: string; cwd: string; directory: string;
  environment: typeof environments.$inferSelect;
  lease: typeof environmentLeases.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
};

export function registerAgentHomeOwnershipCases(input: {
  db: () => Db;
  owner: (options?: { status?: string; writerDirectory?: boolean }) => Promise<Owner>;
  stored: (id: string) => Promise<EnvironmentLease>;
}) {
  async function legacyOwner(status = "succeeded", leaseStatus = "released") {
    const f = await input.owner({ status, writerDirectory: false });
    const realization = buildWorkspaceRealizationRecordFromDriverInput({
      environment: f.environment as Environment, lease: f.lease as EnvironmentLease,
      workspace: { localPath: f.cwd }, cwd: f.cwd,
      providerMetadata: { remoteCwd: f.cwd, workspaceRealization: { mode: "in_place", authoritativeRoot: f.cwd } },
    });
    realization.local.source = "agent_home";
    await input.db().update(environmentLeases).set({ executionWorkspaceId: null, status: leaseStatus,
      expiresAt: leaseStatus === "expired" ? new Date(0) : null,
      metadata: { ...f.lease.metadata, workspaceRealization: realization },
    }).where(eq(environmentLeases.id, f.lease.id));
    return { ...f, lease: await input.stored(f.lease.id) };
  }

  it("recovers three legacy agent-home owners from earlier controllers without writer records", async () => {
    const owners = await Promise.all([legacyOwner(), legacyOwner(), legacyOwner()]);
    const controller = randomUUID();
    for (const [index, f] of owners.entries()) {
      const file = path.join(path.dirname(f.cwd), ".paperclip-in-place-locks",
        createHash("sha256").update(f.cwd).digest("hex"));
      const lock = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...lock, ownerId: index < 2 ? controller : randomUUID() }));
    }
    expect(await createSshInPlaceOwnershipReconciler(input.db())()).toEqual({ scanned: 3, released: 3 });
    for (const f of owners) {
      expect(hasRemoteTerminationReceipt(await input.stored(f.lease.id))).toBe(true);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
    }
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])(
    "releases a legacy agent-home lock when a %s run ends", async status => {
      const f = await legacyOwner(status);
      const released = await createSshEnvironmentDriver(input.db()).releaseRunLease({
        environment: f.environment as Environment, lease: f.lease, status: status === "succeeded" ? "released" : "failed",
      });
      expect(hasRemoteTerminationReceipt(released!)).toBe(true);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
    });

  it("recovers an expired legacy agent-home lease during the next acquisition", async () => {
    const f = await legacyOwner("interrupted", "expired");
    const nextLeaseId = randomUUID();
    try {
      expect(await acquireSshInPlaceWorktreeLock({ key: f.cwd, leaseId: nextLeaseId,
        runId: randomUUID(), waitMs: 0,
        ...sshInPlaceLockChecks(input.db(), f.companyId, lease =>
          confirmSshInPlaceTermination(input.db(), f.environment as Environment, lease, "expired")),
      })).toEqual({ acquired: true });
      expect(hasRemoteTerminationReceipt(await input.stored(f.lease.id))).toBe(true);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(nextLeaseId);
    } finally { releaseSshInPlaceWorktreeLocksForLease(nextLeaseId); }
  });

  it("releases the canonical lock when a legacy agent-home realization uses a path alias", async () => {
    const f = await legacyOwner("failed");
    const alias = path.join(path.dirname(f.cwd), randomUUID());
    await symlink(f.cwd, alias);
    const realization = f.lease.metadata!.workspaceRealization as Record<string, unknown>;
    await input.db().update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      workspaceRealization: { ...realization, authoritativeRoot: alias,
        local: { ...realization.local as Record<string, unknown>, path: alias } },
    } }).where(eq(environmentLeases.id, f.lease.id));
    const released = await createSshEnvironmentDriver(input.db()).releaseRunLease({
      environment: f.environment as Environment, lease: await input.stored(f.lease.id), status: "failed",
    });
    expect(hasRemoteTerminationReceipt(released!)).toBe(true);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)).toBeNull();
  });

  it.each(["queued", "running"])("preserves an expired legacy agent-home owner whose run remains %s", async status => {
    const f = await legacyOwner(status, "expired");
    expect(await createSshInPlaceOwnershipReconciler(input.db())()).toEqual({ scanned: 0, released: 0 });
    expect(await confirmSshInPlaceTermination(input.db(), f.environment as Environment, f.lease, "expired")).toBeNull();
    expect(hasRemoteTerminationReceipt(await input.stored(f.lease.id))).toBe(false);
    expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
  });

  it.each(["version", "provider", "local", "mode", "leaseId", "environmentId", "providerLeaseId", "authoritativeRoot"])(
    "preserves legacy agent-home ownership when realization %s differs", async field => {
      const f = await legacyOwner();
      const realization = f.lease.metadata!.workspaceRealization as Record<string, unknown>;
      await input.db().update(environmentLeases).set({ metadata: { ...f.lease.metadata,
        workspaceRealization: { ...realization, [field]: "different" },
      } }).where(eq(environmentLeases.id, f.lease.id));
      expect((await createSshInPlaceOwnershipReconciler(input.db())()).released).toBe(0);
      expect(readSshInPlaceWorktreeLockHolder(f.cwd)?.leaseId).toBe(f.lease.id);
      expect(hasRemoteTerminationReceipt(await input.stored(f.lease.id))).toBe(false);
    });
}
