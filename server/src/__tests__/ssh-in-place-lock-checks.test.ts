import { expect, it, vi } from "vitest";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { sshInPlaceLockChecks } from "../services/ssh-in-place-lock-checks.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

const holder = { leaseId: "lease", runId: "run", acquiredAt: 1, ownerId: "controller" };
function fixture(runStatus: string, leaseRunId = "run") {
  const lease = { id: "lease", companyId: "company", heartbeatRunId: leaseRunId, provider: "ssh",
    providerLeaseId: "ssh://host/work", status: "active", metadata: {}, releasedAt: null, cleanupStatus: null,
  } as unknown as EnvironmentLease;
  const db = { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === environmentLeases ? [lease] : [{ status: runStatus }],
  }) }) }) } as unknown as Db;
  const confirm = vi.fn(async () => ({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
    metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) },
  }) as unknown as EnvironmentLease);
  return { lease, confirm, checks: sshInPlaceLockChecks(db, "company", confirm) };
}

it("requires a terminal owner run before it checks an active lease for termination", async () => {
  const { checks, confirm } = fixture("running");
  expect(await checks.isHolderActive(holder)).toBe(true);
  expect(await checks.isHolderStopped(holder)).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
});

it.each(["succeeded", "failed", "cancelled", "timed_out"])("recovers an active lease for a %s owner only with a saved receipt", async (status) => {
  const { checks, confirm } = fixture(status);
  expect(await checks.isHolderActive(holder)).toBe(false);
  expect(await checks.isHolderStopped(holder)).toBe(true);
  confirm.mockResolvedValueOnce(null as unknown as EnvironmentLease);
  expect(await checks.isHolderStopped(holder)).toBe(false);
});

it("refuses a receipt when the ownership run differs from the lease run", async () => {
  const { checks, confirm } = fixture("succeeded", "other-run");
  expect(await checks.isHolderStopped(holder)).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
});
