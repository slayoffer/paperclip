import { describe, expect, it } from "vitest";
import { adapterExecutionTargetSessionMatches } from "@paperclipai/adapter-utils/execution-target";
import { sessionCodec } from "./index.js";

describe("Codex saved SSH session identity", () => {
  it.each([false, true])("preserves the target through persistence with owner scope %s", (owner) => {
    const remoteExecution = { transport: "ssh", host: "fixture.invalid", port: 22,
      username: "fixture", remoteCwd: "/workspace" };
    const params = { sessionId: "source-thread", cwd: "/workspace", remoteExecution,
      ...(owner ? { ownerSession: true, ownerSessionIssueId: "issue-a" } : {}),
    };
    const saved = sessionCodec.serialize(params);
    const restored = sessionCodec.deserialize(saved);
    expect(restored).toEqual(params);
    const target = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/workspace", spec: {
      ...remoteExecution, remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null,
      strictHostKeyChecking: true,
    } };
    expect(adapterExecutionTargetSessionMatches(restored?.remoteExecution, target)).toBe(true);
    expect(adapterExecutionTargetSessionMatches(restored?.remoteExecution, {
      ...target, spec: { ...target.spec, host: "other.invalid" },
    })).toBe(false);
  });

  it("keeps only identity fields and does not manufacture owner scope", () => {
    const restored = sessionCodec.deserialize(sessionCodec.serialize({ sessionId: "source-thread",
      remoteExecution: { transport: "ssh", host: "fixture.invalid", port: 22,
        username: "fixture", remoteCwd: "/workspace", privateKey: "fixture-only", knownHosts: "fixture-only" },
    }));
    expect(restored).toEqual({ sessionId: "source-thread", remoteExecution: {
      transport: "ssh", host: "fixture.invalid", port: 22, username: "fixture", remoteCwd: "/workspace",
    } });
  });
});
