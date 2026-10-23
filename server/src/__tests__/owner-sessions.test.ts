import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute as executeCodex, sessionCodec as codexCodec } from "@paperclipai/adapter-codex-local/server";
import { execute as executeClaude, sessionCodec as claudeCodec } from "@paperclipai/adapter-claude-local/server";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { prepareOwnerSessionLaunch } from "@paperclipai/adapter-utils/owner-session";
import { selectPaperclipPromptSections } from "@paperclipai/adapter-utils/server-utils";
import { sshProviderSessionDirectories } from "@paperclipai/adapter-utils/ssh-provider-sessions";
import { ownerSessionInputLimit, ownerSessionsEnabled, resolveOwnerSession, ownerSessionEngineEligible, shouldResetOwnerSessionForWake, describeOwnerSessionResetReason } from "../services/owner-sessions.js";
import { sessionCompactionReason, buildSessionCompactionHandoff } from "../services/session-compaction-decision.js";

afterEach(() => vi.unstubAllEnvs());

const agent = { id: "owner-a", companyId: "company-a", adapterType: "codex_local" };

describe("owner session policy", () => {
  it("preserves task sessions when disabled and limits the canary to selected owners", () => {
    expect(ownerSessionsEnabled(agent, {})).toBe(false);
    const env = { PAPERCLIP_OWNER_SESSIONS_ENABLED: "true", PAPERCLIP_OWNER_SESSION_AGENT_IDS: "owner-a" };
    expect(ownerSessionsEnabled(agent, env)).toBe(true);
    expect(ownerSessionsEnabled({ ...agent, id: "owner-b" }, env)).toBe(false);
    expect(ownerSessionsEnabled({ ...agent, adapterType: "paperclip_runner" }, env)).toBe(false);
  });

  it("uses one key per owner project and excludes ineligible execution", () => {
    vi.stubEnv("PAPERCLIP_OWNER_SESSIONS_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_OWNER_SESSION_AGENT_IDS", "");
    const input = { agent, issue: { projectId: "project-a" }, agentHome: "/owner-a", eligible: true };
    expect(resolveOwnerSession(input)?.key).toBe("owner-project:project-a");
    expect(resolveOwnerSession(input)).toEqual(resolveOwnerSession({ ...input }));
    expect(resolveOwnerSession({ ...input, issue: { projectId: "project-b" } })?.key).not.toBe(resolveOwnerSession(input)?.key);
    expect(resolveOwnerSession({ ...input, eligible: false })).toBeNull();
    expect(resolveOwnerSession({ ...input, issue: { projectId: null } })).toBeNull();
  });

  it("keeps the owner thread across the wakes that reset a task session", () => {
    for (const wakeReason of ["issue_assigned", "execution_approval_requested", "heartbeat_timer"]) {
      const context = { wakeReason };
      expect(shouldResetOwnerSessionForWake(context)).toBe(false);
      expect(describeOwnerSessionResetReason(context)).toBeNull();
    }
    expect(shouldResetOwnerSessionForWake({ wakeReason: "issue_assigned", forceFreshSession: true })).toBe(true);
    expect(describeOwnerSessionResetReason({ forceFreshSession: true })).toBe("forceFreshSession was requested");
  });

  it("uses the effective engine after issue overrides", () => {
    expect(ownerSessionEngineEligible({ engine: "cli" }, { engine: "acp" })).toBe(false);
    expect(ownerSessionEngineEligible({ engine: "acp" }, { engine: "cli" })).toBe(true);
    expect(ownerSessionEngineEligible({ engine: " CLI " })).toBe(true);
    expect(ownerSessionEngineEligible({})).toBe(false);
  });

  it("accepts only a positive integer for the input limit", () => {
    expect(ownerSessionInputLimit({ PAPERCLIP_OWNER_SESSION_MAX_INPUT_TOKENS: "3000000" })).toBe(3_000_000);
    for (const value of ["", "-1", "Infinity", "1.5", "bad"]) {
      expect(ownerSessionInputLimit({ PAPERCLIP_OWNER_SESSION_MAX_INPUT_TOKENS: value })).toBeNull();
    }
  });

  it("rotates at the configured size and preserves a summary for the new thread", () => {
    const input = { policy: { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 1000, maxSessionAgeHours: 0 }, runs: 2, inputTokens: 999, ageHours: 1 };
    expect(sessionCompactionReason(input)).toBeNull();
    const reason = sessionCompactionReason({ ...input, inputTokens: 1000 });
    expect(reason).toContain("threshold 1,000");
    const handoff = buildSessionCompactionHandoff({ sessionId: "thread-a", issueId: "issue-b", reason: reason!, summary: "First issue complete", continuationSummary: "Current issue needs tests" });
    expect(handoff).toContain("thread-a");
    expect(handoff).toContain("First issue complete");
    expect(handoff).toContain("Current issue needs tests");
  });

  it("omits the assignment only on resumed owner turns", () => {
    const context = { paperclipOwnerSession: { sameIssue: true }, paperclipTaskMarkdown: "full assignment" };
    expect(selectPaperclipPromptSections(context, { resumedSession: true }).taskContextNote).toBe("");
    expect(selectPaperclipPromptSections(context).taskContextNote).toContain("full assignment");
    expect(selectPaperclipPromptSections({ ...context, paperclipOwnerSession: { sameIssue: false } }, { resumedSession: true }).taskContextNote).toContain("full assignment");
    expect(selectPaperclipPromptSections({ paperclipTaskMarkdown: "full assignment" }, { resumedSession: true }).taskContextNote).toBe("full assignment");
  });

  it("keeps SSH transcripts across issue worktrees", () => {
    const input = { runtimeRoot: "/runs/one/codex", adapterKey: "codex", companyId: "company-a", assetKeys: ["home"], providerSessionRoot: "/owners/company-a/owner-a/project-a/provider-sessions" };
    const first = sshProviderSessionDirectories({ ...input, workspace: "/issues/one" });
    const second = sshProviderSessionDirectories({ ...input, workspace: "/issues/two", runtimeRoot: "/runs/two/codex" });
    expect(first).toEqual(second);
    expect(first[0].directory).toContain("/company-a/owner-a/project-a/");
  });

  it("rejects a sandbox target before owner directory preparation", async () => {
    await expect(prepareOwnerSessionLaunch({
      context: { paperclipOwnerSession: { projectId: "project-a", localDirectory: "/owner-a" } },
      companyId: "company-a", agentId: "owner-a",
      target: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" },
    })).rejects.toThrow("local or SSH");
  });
});

describe.each([
  { vendor: "codex", execute: executeCodex, codec: codexCodec },
  { vendor: "claude", execute: executeClaude, codec: claudeCodec },
])("$vendor owner turns", ({ vendor, execute, codec }) => {
  it("resumes across two issues and starts fresh with a handoff after a host move", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owner-session-"));
    try {
      const ownerDirectory = path.join(root, "owner");
      const capture = path.join(root, "capture.json");
      const command = path.join(root, "provider.cjs");
      await fs.writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--help")) { console.log("--effort"); process.exit(0); }
fs.writeFileSync(process.env.OWNER_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), prompt: fs.readFileSync(0, "utf8") }));
const id = "11111111-1111-4111-8111-111111111111";
if (${JSON.stringify(vendor)} === "codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 1 } }));
} else {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: id }));
  console.log(JSON.stringify({ type: "result", session_id: id, result: "done", usage: { input_tokens: 100, output_tokens: 1 } }));
}
`);
      await fs.chmod(command, 0o755);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("CODEX_HOME", path.join(root, "codex-home"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-home"));
      await fs.mkdir(path.join(root, "codex-home"));
      await fs.writeFile(path.join(root, "codex-home", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture" }));
      let runtime: AdapterExecutionContext["runtime"] = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "issue-a" };
      let previousIssue: string | null = null;
      const turn = async (issue: string, scope = true) => {
        runtime.sessionParams = codec.deserialize(codec.serialize(runtime.sessionParams));
        const workspace = path.join(root, issue);
        await fs.mkdir(workspace, { recursive: true });
        const result = await execute({
          runId: issue, agent: { id: "owner-a", companyId: "company-a", name: "Owner", adapterType: `${vendor}_local`, adapterConfig: {} }, runtime,
          config: { engine: "cli", command, cwd: workspace, env: { OWNER_CAPTURE: capture, OPENAI_API_KEY: "fixture", CODEX_HOME: path.join(root, "codex-home") } },
          context: {
            issueId: issue, paperclipWorkspace: { cwd: workspace, branchName: `review/${issue}` },
            paperclipTaskMarkdown: `Assignment for ${issue}`,
            ...(scope ? { paperclipOwnerSession: { projectId: "project-a", localDirectory: ownerDirectory, sameIssue: previousIssue === issue, handoffMarkdown: "Saved owner summary" } } : {}),
          },
          onLog: async () => {},
        });
        expect(result.exitCode, result.errorMessage ?? undefined).toBe(0);
        previousIssue = issue;
        runtime = { ...runtime, sessionId: result.sessionId ?? null, sessionDisplayId: result.sessionDisplayId ?? null, sessionParams: result.sessionParams ?? null };
        return { result, captured: JSON.parse(await fs.readFile(capture, "utf8")) };
      };
      const first = await turn("issue-a");
      const second = await turn("issue-b");
      expect(first.captured.cwd).toBe(ownerDirectory);
      expect(second.captured.cwd).toBe(ownerDirectory);
      expect(second.captured.args).toContain(vendor === "codex" ? "resume" : "--resume");
      expect(second.captured.prompt).toContain(path.join(root, "issue-b"));
      expect(second.captured.prompt).toContain("Assignment for issue-b");
      const sameIssue = await turn("issue-b");
      expect(sameIssue.captured.args).toContain(vendor === "codex" ? "resume" : "--resume");
      expect(sameIssue.captured.prompt).not.toContain("Assignment for");
      if (vendor === "codex") expect(second.result.usageBasis).toBe("session_cumulative");
      runtime.sessionParams = { ...runtime.sessionParams, remoteExecution: { transport: "ssh", host: "old-host", port: 22, username: "fixture", remoteCwd: ownerDirectory } };
      const moved = await turn("issue-c");
      expect(moved.captured.args).not.toContain(vendor === "codex" ? "resume" : "--resume");
      expect(moved.captured.prompt).toContain("Saved owner summary");
      expect(moved.captured.prompt).toContain("Assignment for issue-c");
      const disabled = await turn("issue-d", false);
      expect(disabled.captured.cwd).toBe(path.join(root, "issue-d"));
      expect(disabled.captured.args).not.toContain(vendor === "codex" ? "resume" : "--resume");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
