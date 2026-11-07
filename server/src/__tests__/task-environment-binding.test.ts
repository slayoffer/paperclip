import { describe, expect, it } from "vitest";
import { requiresTaskEnvironmentBinding } from "../services/execution-workspaces.js";

describe("task environment binding", () => {
  const local = "local-env";
  const remote = "remote-env";

  it("treats a saved workspace without an environment id as the local default", () => {
    expect(requiresTaskEnvironmentBinding({ config: {} }, local, local)).toBe(false);
    expect(requiresTaskEnvironmentBinding({ config: null }, local, local)).toBe(false);
  });

  it("requires a separate binding when a legacy workspace moves off the local default", () => {
    expect(requiresTaskEnvironmentBinding({ config: {} }, remote, local)).toBe(true);
  });

  it("compares a recorded environment id exactly", () => {
    expect(requiresTaskEnvironmentBinding({ config: { environmentId: remote } }, remote, local)).toBe(false);
    expect(requiresTaskEnvironmentBinding({ config: { environmentId: remote } }, local, local)).toBe(true);
  });

  it("stays conservative when the local default is unknown", () => {
    expect(requiresTaskEnvironmentBinding({ config: {} }, local)).toBe(true);
  });

  it("needs no binding without a workspace or a selection", () => {
    expect(requiresTaskEnvironmentBinding(null, local, local)).toBe(false);
    expect(requiresTaskEnvironmentBinding({ config: {} }, null, local)).toBe(false);
  });
});
