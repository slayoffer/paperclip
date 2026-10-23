import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { RESTART_RESUME_PROMPT } from "@paperclipai/adapter-utils/server-utils";

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("resumes the checkpoint session without a fresh fallback (missing=%s)", async missing => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-restart-resume-"));
  try {
    const command = path.join(cwd, "codex");
    const capture = path.join(cwd, "capture.jsonl");
    const codexHome = path.join(cwd, "home");
    await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test-restart" }));
    vi.stubEnv("CODEX_HOME", codexHome);
    await fs.writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt: fs.readFileSync(0, "utf8") }) + "\\n");
if (${missing}) {
  console.error("state db missing rollout path for thread restart-thread");
  process.exit(1);
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "restart-thread" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
    const onEvent = vi.fn();
    const result = execute({
      runId: "restart-run",
      agent: { id: "agent", companyId: "company", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: "restart-thread", sessionDisplayId: "restart-thread",
        sessionParams: { sessionId: "restart-thread", cwd }, taskKey: "owner-project:test" },
      config: { engine: "cli", command, cwd, promptTemplate: "Full task context must not repeat." },
      context: { paperclipRestartResume: true }, onLog: async () => {}, onEvent,
    });
    if (missing) await expect(result).rejects.toThrow("restart_session_missing");
    else {
      expect(await result).toMatchObject({ exitCode: 0, sessionId: "restart-thread" });
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "session.checkpoint",
        payload: expect.objectContaining({ sessionParams: { cwd, sessionId: "restart-thread" } }) }));
    }
    const invocations = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(invocations).toHaveLength(1);
    expect(invocations[0].args).toEqual(expect.arrayContaining(["resume", "restart-thread", "-"]));
    expect(invocations[0].prompt).toBe(RESTART_RESUME_PROMPT);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
