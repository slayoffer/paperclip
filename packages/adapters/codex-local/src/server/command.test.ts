import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { runAdapterExecutionTargetShellCommand } = vi.hoisted(() => ({
  runAdapterExecutionTargetShellCommand: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return { ...actual, runAdapterExecutionTargetShellCommand };
});

import { resolveCodexCommand } from "./command.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function localInput() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-command-"));
  cleanupDirs.push(cwd);
  await writeFile(path.join(cwd, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    runId: "run-1",
    command: path.join(cwd, "codex-owner-apps"),
    cwd,
    env: { PATH: cwd },
    target: null as AdapterExecutionTarget | null,
    onLog: vi.fn(async (_stream: "stdout" | "stderr", _line: string) => {}),
  };
}

function probeResult(marker: "present" | "missing") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: `profile output\npaperclip-command-${marker}\n`,
    stderr: "",
  };
}

describe("Codex command selection", () => {
  it.each(["path", "name"])("uses codex when a configured %s is absent locally", async (kind) => {
    const input = await localInput();
    if (kind === "name") input.command = "codex-owner-apps";
    expect(await resolveCodexCommand(input)).toBe("codex");
    expect(input.onLog).toHaveBeenCalledExactlyOnceWith(
      "stderr",
      expect.stringContaining(`Configured command ${JSON.stringify(input.command)}`),
    );
    expect(input.onLog.mock.calls[0]?.[1]).toContain('adapter default "codex"');
    expect(runAdapterExecutionTargetShellCommand).not.toHaveBeenCalled();
  });

  it("preserves an existing command without executing it", async () => {
    const input = await localInput();
    await writeFile(input.command, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    expect(await resolveCodexCommand(input)).toBe(input.command);
    expect(input.onLog).not.toHaveBeenCalled();
  });

  it.each(["path", "name"])("preserves a local %s without execute permission", async (kind) => {
    const input = await localInput();
    await writeFile(input.command, "#!/bin/sh\nexit 42\n");
    await chmod(input.command, 0o600);
    if (kind === "name") input.command = "codex-owner-apps";
    expect(await resolveCodexCommand(input)).toBe(input.command);
    expect(input.onLog).not.toHaveBeenCalled();
  });

  it("fails when both commands are absent locally", async () => {
    const input = await localInput();
    await rm(path.join(input.cwd, "codex"));
    await expect(resolveCodexCommand(input)).rejects.toThrow('adapter default "codex" are missing');
    expect(input.onLog).not.toHaveBeenCalled();
  });

  it("does not replace a missing default command", async () => {
    const input = await localInput();
    input.command = "codex";
    await rm(path.join(input.cwd, "codex"));
    await expect(resolveCodexCommand(input)).rejects.toThrow('Command not found in PATH: "codex"');
    expect(input.onLog).not.toHaveBeenCalled();
  });

  it("uses the host search path to validate the SSH client", async () => {
    const input = await localInput();
    await writeFile(path.join(input.cwd, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("PATH", input.cwd);
    input.command = "codex";
    input.env.PATH = "/remote-only/bin";
    input.target = { kind: "remote", transport: "ssh", spec: {} } as AdapterExecutionTarget;
    expect(await resolveCodexCommand(input)).toBe("codex");
    expect(runAdapterExecutionTargetShellCommand).not.toHaveBeenCalled();
  });

  // Both transports must probe the leased environment rather than host files.
  const targets: AdapterExecutionTarget[] = [
    { kind: "remote", transport: "ssh", spec: { remoteCwd: "/remote/workspace" } } as AdapterExecutionTarget,
    { kind: "remote", transport: "sandbox", remoteCwd: "/remote/workspace" } as AdapterExecutionTarget,
  ];

  describe.each(targets)("$transport target", (target) => {
    it.each([
      { state: "missing", kind: "path" },
      { state: "present", kind: "path" },
      { state: "present", kind: "name" },
    ])("runs the quoted shell probe: $state $kind", async ({ state, kind }) => {
      const input = { ...await localInput(), target };
      const markerPath = path.join(input.cwd, "injected");
      input.command = path.join(input.cwd, "wrapper'$(touch injected)");
      if (state === "present") {
        await writeFile(input.command, "#!/bin/sh\nexit 42\n", { mode: 0o600 });
      }
      if (kind === "name") input.command = path.basename(input.command);
      runAdapterExecutionTargetShellCommand.mockImplementation(async (_runId, _target, script) => {
        const result = await promisify(execFile)("/bin/sh", ["-c", script], {
          cwd: input.cwd, env: input.env,
        });
        return { ...result, exitCode: 0, signal: null, timedOut: false };
      });
      expect(await resolveCodexCommand(input)).toBe(state === "present" ? input.command : "codex");
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("checks both commands on the target before selecting codex", async () => {
      const input = { ...await localInput(), target, cwd: "/remote/workspace" };
      // The wrapper exists on the host but is absent on the lease.
      await writeFile(input.command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      runAdapterExecutionTargetShellCommand
        .mockResolvedValueOnce(probeResult("missing"))
        .mockResolvedValueOnce(probeResult("present"));
      expect(await resolveCodexCommand(input)).toBe("codex");
      expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledTimes(2);
      expect(runAdapterExecutionTargetShellCommand).toHaveBeenNthCalledWith(
        1, input.runId, target, expect.stringContaining(input.command),
        expect.objectContaining({ cwd: input.cwd, env: input.env, timeoutSec: 15 }),
      );
      expect(runAdapterExecutionTargetShellCommand.mock.calls[1]?.[2]).toContain("command -v 'codex'");
      expect(input.onLog).toHaveBeenCalledTimes(1);
    });

    it("retains an existing remote wrapper", async () => {
      const input = { ...await localInput(), target };
      runAdapterExecutionTargetShellCommand.mockResolvedValueOnce(probeResult("present"));
      expect(await resolveCodexCommand(input)).toBe(input.command);
      expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledTimes(1);
      expect(input.onLog).not.toHaveBeenCalled();
    });

    it("fails when codex is also absent remotely", async () => {
      const input = { ...await localInput(), target };
      runAdapterExecutionTargetShellCommand.mockResolvedValue(probeResult("missing"));
      await expect(resolveCodexCommand(input)).rejects.toThrow('adapter default "codex" are missing');
      expect(input.onLog).not.toHaveBeenCalled();
    });

    it.each([
      { exitCode: 255 },
      { timedOut: true },
      { signal: "SIGTERM" },
      { stdout: "invalid response" },
    ])("preserves a probe failure: %j", async (failure) => {
      const input = { ...await localInput(), target };
      runAdapterExecutionTargetShellCommand.mockResolvedValueOnce({ ...probeResult("missing"), ...failure });
      await expect(resolveCodexCommand(input)).rejects.toThrow();
      expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledTimes(1);
      expect(input.onLog).not.toHaveBeenCalled();
    });
  });
});
