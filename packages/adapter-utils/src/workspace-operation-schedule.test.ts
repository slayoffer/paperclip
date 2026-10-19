import { expect, it } from "vitest";
import { WorkspaceOperationSchedule, timeWorkspaceStep } from "./workspace-operation-schedule.js";

it("bounds a burst of 24 operations and admits them in arrival order", async () => {
  const schedule = new WorkspaceOperationSchedule(2);
  let active = 0;
  let peak = 0;
  const admitted: number[] = [];
  await Promise.all(Array.from({ length: 24 }, (_, index) => schedule.run(async () => {
    admitted.push(index);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  })));
  expect(peak).toBe(2);
  expect(admitted).toEqual(Array.from({ length: 24 }, (_, i) => i));
});

it("releases a slot after failure and permits recovery within the same slot", async () => {
  const schedule = new WorkspaceOperationSchedule(1);
  const failure = new Error("prepare failed");
  const first = schedule.run(async () => {
    await schedule.run(async () => undefined);
    throw failure;
  });
  const next = schedule.run(async () => "restored");
  await expect(first).rejects.toBe(failure);
  await expect(next).resolves.toBe("restored");
});

it("logs the start and elapsed time of successful and failed steps", async () => {
  const lines: string[] = [];
  const sink = (line: string) => { lines.push(line); };
  await expect(timeWorkspaceStep(sink, "Git import", async () => 42)).resolves.toBe(42);
  const failure = new Error("sync failed");
  await expect(timeWorkspaceStep(sink, "Workspace sync", async () => { throw failure; })).rejects.toBe(failure);
  expect(lines).toEqual([
    "[paperclip] Git import started.\n",
    expect.stringMatching(/^\[paperclip\] Git import completed in \d+ ms\.\n$/),
    "[paperclip] Workspace sync started.\n",
    expect.stringMatching(/^\[paperclip\] Workspace sync failed in \d+ ms\.\n$/),
  ]);
});
