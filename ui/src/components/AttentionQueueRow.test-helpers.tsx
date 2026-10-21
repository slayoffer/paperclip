// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, vi } from "vitest";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { ToastViewport } from "./ToastViewport";
import { ToastProvider } from "../context/ToastContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
export let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

export function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          {element}
          <ToastViewport />
        </QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

export function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "approval-1",
      companyId: "c1",
      title: "Hire agent: Research Analyst",
      identifier: null,
      status: "pending",
      href: "/PAP/approvals/approval-1",
      metadata: {},
    },
    whyNow: "Approval is pending a board decision.",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "approval:approval-1",
    dismissalKey: "attention:approval:approval-1",
    severity: "high",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
    expiresAt: overrides.expiresAt ?? null,
    ruleKey: overrides.ruleKey ?? null,
    originAgentName: overrides.originAgentName ?? null,
    queues: overrides.queues ?? [],
    shelf: overrides.shelf ?? false,
    retentionDays: overrides.retentionDays ?? 30,
    keep: overrides.keep ?? false,
    archivedAt: overrides.archivedAt ?? null,
    retentionVersion: overrides.retentionVersion ?? 1,
    decideBy: overrides.decideBy ?? null,
    decideByAttribution: overrides.decideByAttribution ?? null,
    snoozedUntil: overrides.snoozedUntil ?? null,
    trainingExampleId: overrides.trainingExampleId ?? null,
  };
}

export const noop = () => {};
