import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createAcpxEngineExecutor } from "@paperclipai/adapter-utils/acpx-engine/execute";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/** Execute the real ACP startup and bridge factory with local synthetic transports. */
export async function executeSyntheticRemoteAcp(
  ctx: AdapterExecutionContext,
  beforeExposure: (value: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "synthetic-acp-"));
  const cwd = path.join(root, "workspace");
  const remoteCwd = path.join(root, "remote");
  await Promise.all([mkdir(cwd), mkdir(remoteCwd)]);
  let bridgeValue = "";
  const execute = createAcpxEngineExecutor({
    warmHandles: new Map(), stagedRuntimes: new Map(), stagingLocks: new Map(),
    createRuntime: () => ({
      ensureSession: async () => ({
        backendSessionId: "synthetic-backend", agentSessionId: "synthetic-agent", runtimeSessionName: "synthetic-runtime",
      }),
      startTurn: () => ({
        events: (async function* () {
          if (!bridgeValue) throw new Error("Synthetic ACP bridge value was not exposed");
          for (const stream of ["stdout", "stderr"] as const) {
            await ctx.onLog(stream, bridgeValue.slice(0, 11));
            await ctx.onLog(stream, `${bridgeValue.slice(11)}\nneutral ACP output\n`);
          }
          yield { type: "text_delta", text: bridgeValue, stream: "output", tag: "agent_message_chunk" };
          yield { type: "done", stopReason: "end_turn" };
        })(),
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async () => {},
      }),
      setConfigOption: async () => {},
      close: async () => {},
    }) as never,
  });
  try {
    return await execute({
      ...ctx,
      config: { agent: "custom", agentCommand: "node synthetic-acp.js", stateDir: path.join(root, "state"), cwd },
      executionTarget: {
        kind: "remote", transport: "sandbox", providerKey: "local-test", remoteCwd,
        streamRunLogs: false,
        runner: { execute: async input => {
          const value = input.env?.PAPERCLIP_BRIDGE_TOKEN;
          if (value) {
            // Observe the first transport exposure. No test calls registration directly.
            await beforeExposure(value);
            bridgeValue = value;
          }
          return runChildProcess(ctx.runId, input.command, input.args ?? [], {
            cwd: input.cwd ?? remoteCwd, env: input.env ?? {}, stdin: input.stdin,
            timeoutSec: 15, graceSec: 1, onLog: input.onLog ?? (async () => {}),
          });
        } },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
