import { vi } from "vitest";
import { registerPreResultCases } from "./native-session-resumption-pre-result-cases.js";
import { registerPersistedRecoveryCases } from "./native-session-resumption-persisted-cases.js";

const legacyAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "Fresh flag-off run completed through legacy.",
  resultJson: { summary: "fresh legacy after persisted native recovery" },
  provider: "test",
  model: "legacy-test",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      execute: legacyAdapterExecute,
      supportsLocalAgentJwt: false,
    })),
  };
});

const mockCaptureRunFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", async () => {
  const actual = await vi.importActual<typeof import("../sentry.js")>("../sentry.js");
  return { ...actual, captureRunFailure: mockCaptureRunFailure };
});

registerPreResultCases(mockCaptureRunFailure);
registerPersistedRecoveryCases(legacyAdapterExecute);
