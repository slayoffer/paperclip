import { describe, expect, it } from "vitest";
import type { AdapterExecutionTarget } from "./execution-target.js";
import { githubOperationLauncherDirectory } from "./github-launcher-directory.js";

const target = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/repo",
  workspaceRealization: {
    mode: "in_place",
    authoritativeRoot: "/repo",
    runtimeRoot: "/runtime/run-one",
  },
} as AdapterExecutionTarget;

describe("GitHub launcher placement", () => {
  it("uses the isolated root for in-place execution", () => {
    expect(githubOperationLauncherDirectory({ runId: "run-one", target }))
      .toBe("/runtime/run-one/github/run-one");
  });

  it.each([null, "", "relative/root"])("refuses an invalid in-place root: %s", (runtimeRoot) => {
    expect(() => githubOperationLauncherDirectory({
      runId: "run-one",
      target: { ...target, workspaceRealization: { mode: "in_place", runtimeRoot } } as AdapterExecutionTarget,
    })).toThrow("Missing isolated runtime root");
  });

  it("keeps the existing location for copied workspaces", () => {
    expect(githubOperationLauncherDirectory({
      runId: "run-one",
      target: { ...target, workspaceRealization: { mode: "copy" } } as AdapterExecutionTarget,
    })).toBe("/repo/.paperclip-runtime/github/run-one");
  });

  it("refuses a run identifier that can escape its cleanup directory", () => {
    expect(() => githubOperationLauncherDirectory({ runId: "../other", target })).toThrow("Invalid GitHub launcher run ID");
  });
});
