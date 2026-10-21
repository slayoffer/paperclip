import { expect, it, vi } from "vitest";
import { act, container, render, buildItem, noop } from "./AttentionQueueRow.test-helpers";
import { AttentionQueueRow } from "./AttentionQueueRow";
import { useState } from "react";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";

export function registerEvidenceCases() {
  // The old context row bundled project identity + thumbnails together; project
  // identity has since moved up into the meta breadcrumb, so evidence is now a
  // block of the row's own column rather than a shared strip.
  it("renders evidence thumbnails as their own block below the text stack", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          detail: {
            kind: "generic",
            summaryExcerpt: "Visual evidence attached.",
            images: [{ assetId: "asset-1", alt: "Screenshot" }],
          },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const image = container?.querySelector('img[alt="Screenshot"]');
    expect(image?.getAttribute("src")).toBe("/api/assets/asset-1/content");

    const thumbnailStack = image?.parentElement?.parentElement;
    expect(thumbnailStack?.getAttribute("class")).toContain("items-center");
    // The strip is collapsed-only content: it rides the inverse disclosure so
    // it can fade out as the expanded gallery fades in, rather than popping.
    const cluster = thumbnailStack?.closest("[data-decision-disclosure]");
    expect(cluster).toBeTruthy();
    expect(cluster?.getAttribute("data-state")).toBe("open");
    expect(cluster?.closest("[data-attention-row]")).toBeTruthy();
  });

  it("is memoized — a parent re-render with identical props does not re-render the row", async () => {
    const { relativeTime } = await import("../lib/utils");
    const item = buildItem();
    let bump: () => void = () => {};
    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((n) => n + 1);
      return (
        <AttentionQueueRow
          item={item}
          companyId="c1"
          expanded={false}
          onToggleExpand={noop}
          onDismiss={noop}
        />
      );
    }
    render(<Harness />);
    const rendersAfterMount = vi.mocked(relativeTime).mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);
    act(() => bump());
    expect(vi.mocked(relativeTime).mock.calls.length).toBe(rendersAfterMount);
  });

  it("does not expose a toggle button for non-inline rows", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ sourceKind: "failed_run" as AttentionSourceKind, inlineResolvable: false })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(container?.querySelector('[role="button"][aria-expanded]')).toBeNull();
  });

  it("makes a non-inline row with images expandable", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          detail: {
            kind: "generic",
            summaryExcerpt: "3 files changed",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
            ],
          },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );
    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header).not.toBeNull();
    act(() => (header as HTMLElement).click());
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("shows a larger gallery with an n-more link to the issue when expanded", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          relatedIssue: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "Ship it",
            identifier: "PAP-42",
            status: "in_progress",
            href: "/PAP/issues/PAP-42",
            metadata: {},
          },
          detail: {
            kind: "generic",
            summaryExcerpt: "5 screenshots",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
              { assetId: "img-3", alt: "three" },
              { assetId: "img-4", alt: "four" },
              { assetId: "img-5", alt: "five" },
            ],
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const gallery = container?.querySelector('[data-attention-expanded-images="true"]');
    expect(gallery).not.toBeNull();
    // First three images render at the larger size.
    expect(gallery?.querySelectorAll("img")).toHaveLength(3);
    // "n more" link points at the related issue (5 images − 3 shown = 2 more).
    const moreLink = Array.from(gallery?.querySelectorAll("a") ?? []).find((a) =>
      a.textContent?.includes("2 more"),
    );
    expect(moreLink).toBeDefined();
    expect(moreLink?.getAttribute("href")).toBe("/PAP/issues/PAP-42");
  });

  it("shows the remaining image count when no issue link is available", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          subject: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "Unlinked review",
            identifier: null,
            status: "in_review",
            href: null,
            metadata: {},
          },
          detail: {
            kind: "generic",
            summaryExcerpt: "4 screenshots",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
              { assetId: "img-3", alt: "three" },
              { assetId: "img-4", alt: "four" },
            ],
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const gallery = container?.querySelector('[data-attention-expanded-images="true"]');
    expect(gallery?.textContent).toContain("1 more");
    expect(gallery?.querySelectorAll("a")).toHaveLength(0);
  });

  // PAP-17287: the collapsed row must say who may resolve an interaction before
  // its compact verbs are used, and a denial must keep the server's reason.
  function interactionItem(
    audience: AttentionItem["resolverAudience"],
    verbs: AttentionItem["decisionVerbs"] = [
      { id: "accept", label: "Accept", description: null },
      { id: "reject", label: "Reject", description: null },
    ],
  ) {
    return buildItem({
      sourceKind: "issue_thread_interaction",
      subject: {
        kind: "interaction",
        id: "interaction-1",
        companyId: "c1",
        title: "Close this confirmation?",
        identifier: null,
        status: "pending",
        href: "/PAP/issues/issue-1#interaction-interaction-1",
        metadata: { kind: "request_confirmation", issueId: "issue-1", revision: "displayed-revision" },
      },
      decisionVerbs: verbs,
      resolverAudience: audience,
    });
  }

  const openAudience: AttentionItem["resolverAudience"] = {
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    effectiveResolverPolicySource: "requested",
    resolverPolicyProvenance: "inherited",
    addresseeAgentId: null,
    addresseeName: null,
    createdByAgentId: "agent-watchdog",
    createdByAgentName: "Watchdog",
  };

  it("states the server-derived audience before the compact decision verbs", () => {
    render(
      <AttentionQueueRow
        item={interactionItem(openAudience)}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const audience = container?.querySelector('[data-testid="interaction-audience"]');
    expect(audience?.getAttribute("data-audience-policy")).toBe("anyone");
    expect(audience?.getAttribute("data-audience-open")).toBe("true");
    expect(audience?.textContent).toContain("Anyone");
    expect(audience?.textContent).toContain("Anyone can respond");

    // Reading order is the point: the audience qualifies the buttons, so it has
    // to precede them in the DOM as well as on screen.
    const actions = container?.querySelector('[aria-label="Decision actions"]');
    expect(audience && actions && audience.compareDocumentPosition(actions))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("names the addressed responder on a restricted collapsed row", () => {
    render(
      <AttentionQueueRow
        item={interactionItem({
          ...openAudience,
          addresseeAgentId: "agent-codex",
          addresseeName: "CodexCoder",
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const audience = container?.querySelector('[data-testid="interaction-audience"]');
    expect(audience?.getAttribute("data-audience-open")).toBe("false");
    expect(audience?.textContent).toContain("Only CodexCoder or the board can respond");
    // A collapsed row spends its line on the responder, not on a badge that
    // repeats the clause beside it.
    expect(audience?.textContent).not.toContain("Addressed —");
  });

  // PAP-17289: the row's shell is `overflow-hidden`, so a clause that cannot
  // wrap is cut mid-word with no ellipsis and names a responder that does not
  // exist. jsdom does no layout, so this asserts the wrapping rule itself.
  it("lets a long addressee name wrap instead of being cut mid-word", () => {
    const addresseeName = "ReleaseEngineeringPlatformCoordinationServiceBot";
    render(
      <AttentionQueueRow
        item={interactionItem({
          ...openAudience,
          addresseeAgentId: "agent-release",
          addresseeName,
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const audience = container?.querySelector('[data-testid="interaction-audience"]');
    const summary = audience?.querySelector('[data-testid="interaction-audience-summary"]');
    expect(summary?.textContent).toBe(`Only ${addresseeName} or the board can respond`);
    expect(summary?.parentElement?.className).toContain("break-words");
  });

  it("renders no audience line when the feed carries no resolver metadata", () => {
    render(
      <AttentionQueueRow
        item={interactionItem(null)}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    // Never guess a policy client-side: silence beats a wrong audience.
    expect(container?.querySelector('[data-testid="interaction-audience"]')).toBeNull();
  });

  it("requires a displayed revision before a compact answer", async () => {
    const item = interactionItem(openAudience);
    if (item.subject.metadata) delete item.subject.metadata.revision;
    render(
      <AttentionQueueRow
        item={item}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const accept = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Accept",
    );
    act(() => accept?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(issuesApi.acceptInteraction).not.toHaveBeenCalled();
    expect(issuesApi.rejectInteraction).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Refresh this decision before answering.");
  });

  it("keeps the server denial reason and names the responder when a compact accept is refused", async () => {
    vi.mocked(issuesApi.acceptInteraction).mockRejectedValue(
      new ApiError("This issue-thread interaction is human-only", 403, {
        error: "This issue-thread interaction is human-only",
        code: "interaction_human_only",
      }),
    );
    render(
      <AttentionQueueRow
        item={interactionItem({
          ...openAudience,
          requestedResolverPolicy: "human_only",
          effectiveResolverPolicy: "human_only",
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const accept = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Accept",
    );
    act(() => accept?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(issuesApi.acceptInteraction).toHaveBeenCalledWith("issue-1", "interaction-1", { expectedRevision: "displayed-revision" });
    const feedback = document.body.textContent ?? "";
    expect(feedback).toContain("This issue-thread interaction is human-only.");
    expect(feedback).toContain("Only the board can respond.");
    expect(feedback).not.toMatch(/try again/i);
  });

  it("does not surface training state or actions for decisions", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ trainingExampleId: "example-1" })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(container?.textContent).not.toContain("Train");
    expect(container?.querySelector('[data-testid="attention-trained-badge"]')).toBeNull();
    expect(container?.querySelector('[data-testid="attention-train-inline"]')).toBeNull();
    expect(container?.querySelector('[data-testid="attention-train-button"]')).toBeNull();
  });
}
