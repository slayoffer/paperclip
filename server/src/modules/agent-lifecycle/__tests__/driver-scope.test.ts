import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const stop = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../services/heartbeat.js", () => ({ heartbeatService: () => ({ stopInvocationsForAgents: stop }) }));
vi.mock("../../../services/agent-harness-verification.js", () => ({ agentHarnessVerificationService: () => ({ verify: vi.fn() }) }));
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";

describe("lifecycle host stop scope", () => {
  it.each([null, new Date("2026-10-19T01:00:00Z")])("pauses only the requested agent without loading its company peers (pause time: %s)", async (pausedAt) => {
    const db = { select: vi.fn(() => { throw new Error("No peer lookup expected"); }) } as unknown as Db;
    const driver = createLifecycleDriver(db, {} as never);
    expect(await driver.runHost({ id: "target", companyId: "company", lifecycleState: "pausing",
      pausedAt, lifecycleVersion: 2, lifecycleRequiredPluginIds: [], lifecycleError: null, lifecycleOperation: null })).toBe("complete");
    expect(stop).toHaveBeenLastCalledWith(["target"], "Agent lifecycle stop requested", { historyBefore: pausedAt });
    expect(db.select).not.toHaveBeenCalled();
  });
});
