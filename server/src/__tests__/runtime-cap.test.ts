import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs");
});

describe("process admission cap", () => {
  it("shares the admission value and retains it after environment changes", async () => {
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", " 24 ");
    vi.doMock("node:fs", () => ({
      readFileSync: () => `42 (test) S ${Array(18).fill("0").join(" ")} 12345`,
    }));
    const admission = await import("../services/instance-run-cap.js");
    const { getRuntimeCap } = await import("../services/runtime-cap.js");
    expect(admission.getProcessRunningRunsCap()).toBe(24);
    const receipt = getRuntimeCap("first");
    expect(receipt.cap).toBe(admission.getProcessRunningRunsCap());
    expect(Object.isFrozen(receipt)).toBe(true);
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "6");
    expect(admission.maxRunningRunsCap()).toBe(6);
    expect(admission.getProcessRunningRunsCap()).toBe(24);
    expect(getRuntimeCap("second")).toEqual({ ...receipt, nonce: "second" });
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", undefined);
    expect(admission.getProcessRunningRunsCap()).toBe(24);
    expect(getRuntimeCap("third").cap).toBe(24);
  });

  it.skipIf(process.platform !== "linux")("captures through health first and binds the real Linux process", async () => {
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "24");
    const { getRuntimeCap } = await import("../services/runtime-cap.js");
    const receipt = getRuntimeCap("identity");
    const stat = readFileSync("/proc/self/stat", "utf8");
    const expectedTicks = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);
    expect(receipt).toEqual({
      schema: "paperclip.runtime-cap.v1", nonce: "identity", pid: process.pid,
      startTicks: expectedTicks, cap: 24, immutable: true,
    });
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "7");
    const admission = await import("../services/instance-run-cap.js");
    expect(admission.getProcessRunningRunsCap()).toBe(receipt.cap);
  });

  it("reads a new cap only in a new application process", () => {
    const moduleUrl = new URL("../services/instance-run-cap.ts", import.meta.url).href;
    const script = `import { getProcessRunningRunsCap } from ${JSON.stringify(moduleUrl)};
      const first = getProcessRunningRunsCap();
      process.env.PAPERCLIP_MAX_RUNNING_RUNS = '3';
      console.log(JSON.stringify([first, getProcessRunningRunsCap()]));`;
    for (const cap of [24, 6]) {
      const result = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        env: { ...process.env, PAPERCLIP_MAX_RUNNING_RUNS: String(cap) }, encoding: "utf8",
      });
      expect(JSON.parse(result)).toEqual([cap, cap]);
    }
  });

  it.each([undefined, "", "0", "six", "-1", "1.5", "9".repeat(400)])(
    "refuses a receipt for cap %s without changing admission", async (value) => {
      vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", value);
      const admission = await import("../services/instance-run-cap.js");
      const { getRuntimeCap } = await import("../services/runtime-cap.js");
      expect(admission.getProcessRunningRunsCap()).toBe(admission.maxRunningRunsCap());
      expect(() => getRuntimeCap("unavailable")).toThrow("runtime_cap_unavailable");
      vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "24");
      expect(() => getRuntimeCap("still-unavailable")).toThrow("runtime_cap_unavailable");
    },
  );

  it("does not invent process identity when procfs is absent", async () => {
    vi.stubEnv("PAPERCLIP_MAX_RUNNING_RUNS", "24");
    vi.doMock("node:fs", () => ({ readFileSync: () => { throw new Error("ENOENT"); } }));
    const { getRuntimeCap } = await import("../services/runtime-cap.js");
    expect(() => getRuntimeCap("missing")).toThrow("ENOENT");
  });
});

describe("Linux process start ticks", () => {
  it("uses field 22 after a command with spaces and closing parentheses", async () => {
    const { parseProcessStartTicks } = await import("../services/runtime-cap.js");
    const fields = ["S", ...Array(18).fill("0"), "12345", "999"];
    expect(parseProcessStartTicks(`42 (a ) tricky\nname) ${fields.join(" ")}`)).toBe(12345);
  });

  it.each(["", "42 (bad) S 1 2", `42 (bad) S ${Array(18).fill("0").join(" ")} 0`,
    `42 (bad) S ${Array(18).fill("0").join(" ")} 9007199254740992`])(
    "rejects invalid process metadata", async (stat) => {
      const { parseProcessStartTicks } = await import("../services/runtime-cap.js");
      expect(() => parseProcessStartTicks(stat)).toThrow("runtime_cap_process_identity_unavailable");
    },
  );
});
