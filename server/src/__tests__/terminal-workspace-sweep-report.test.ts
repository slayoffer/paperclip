import { describe, expect, it, vi } from "vitest";
import { createTerminalWorkspaceSweepReporter } from "../services/terminal-workspace-sweep-report.js";

const emptyResult = {
  checked: 0,
  eligible: 0,
  archived: 0,
  cleanupFailed: 0,
  skippedConcurrentSweep: 0,
  skippedGitInspection: 0,
  skippedDirty: 0,
  skippedActiveRun: 0,
  skippedNonTerminalTree: 0,
  skippedUndelivered: 0,
  skippedRace: 0,
  skippedReopened: 0,
  skippedCooldown: 0,
  clearedStaleReopenPending: 0,
};

describe("terminal workspace sweep reports", () => {
  it.each([
    [{ checked: 1, skippedReopened: 1 }, "terminal issue workspace reaper skipped all candidates"],
    [{ skippedConcurrentSweep: 1 }, "terminal issue workspace reaper skipped because another sweep still runs"],
    [{}, "terminal issue workspace reaper found no candidates"],
  ])("reports an inactive sweep: %s", (patch, message) => {
    const logger = { info: vi.fn() };
    const report = createTerminalWorkspaceSweepReporter(logger, () => 0);
    const result = { ...emptyResult, ...patch };
    report(result);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(result, message);
  });

  it("limits inactive reports to one in ten minutes", () => {
    const logger = { info: vi.fn() };
    let clock = 0;
    const report = createTerminalWorkspaceSweepReporter(logger, () => clock);
    report(emptyResult);
    clock = 599_999;
    report({ ...emptyResult, skippedConcurrentSweep: 1 });
    expect(logger.info).toHaveBeenCalledTimes(1);
    clock = 600_000;
    report({ ...emptyResult, checked: 1, skippedReopened: 1 });
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it.each(["archived", "cleanupFailed", "clearedStaleReopenPending"] as const)(
    "always reports state changes: %s",
    (field) => {
      const logger = { info: vi.fn() };
      const report = createTerminalWorkspaceSweepReporter(logger, () => 0);
      report(emptyResult);
      const result = { ...emptyResult, [field]: 1 };
      report(result);
      expect(logger.info).toHaveBeenLastCalledWith(result, "terminal issue workspace reaper changed workspace state");
      expect(logger.info).toHaveBeenCalledTimes(2);
    },
  );
});
