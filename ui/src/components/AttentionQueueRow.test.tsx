// @vitest-environment jsdom

import type { AnchorHTMLAttributes } from "react";
import { describe, vi } from "vitest";
import { registerPresentationCases } from "./AttentionQueueRow.presentation-cases";
import { registerDecisionsCases } from "./AttentionQueueRow.decisions-cases";
import { registerEvidenceCases } from "./AttentionQueueRow.evidence-cases";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
    decideStalledReview: vi.fn(() => Promise.resolve({})),
  },
}));

// Spy on `relativeTime` (called exactly once per active-row render) so the
// memoization test below can count row renders without a profiling build.
vi.mock("../lib/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/utils")>();
  return { ...original, relativeTime: vi.fn(original.relativeTime) };
});

describe("AttentionQueueRow", () => {
  registerPresentationCases();
  registerDecisionsCases();
  registerEvidenceCases();
});
