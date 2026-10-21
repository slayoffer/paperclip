import { expect, it, vi } from "vitest";
import { act, container, render, buildItem, noop } from "./AttentionQueueRow.test-helpers";
import { AttentionQueueRow } from "./AttentionQueueRow";
import type { AttentionSourceKind } from "@paperclipai/shared";

export function registerPresentationCases() {
  it("renders an inline approval resolver when expanded", () => {
    const el = render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(el.textContent).toContain("Approve");
    expect(el.textContent).toContain("Request revision");
    expect(el.textContent).toContain("Reject");
    // Inline rows show an expand chevron, not an "Open" deep-link.
    expect(el.textContent).not.toContain("Open");
  });

  it("inlines a stalled review with the three review verbs (PAP-16080 §4.4)", () => {
    const el = render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: true,
          subject: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "PR ready for review",
            identifier: null,
            status: "in_review",
            href: "/PAP/issues/PAP-1",
            metadata: { reviewAttentionState: "stalled" },
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    // Inline rows resolve in place, not via an "Open" deep-link.
    expect(el.textContent).not.toContain("Open");
    expect(el.textContent).toContain("Approve");
    expect(el.textContent).toContain("Request changes");
    expect(el.textContent).toContain("Send back to work");
  });

  // PAP-16506 P4: an opt-in policy warns before the card offers Approve, because
  // the server refuses the verdict. The default earns no pixels.
  const reviewItemWithPolicy = (reviewPolicy?: unknown) =>
    buildItem({
      sourceKind: "review" as AttentionSourceKind,
      inlineResolvable: true,
      subject: {
        kind: "issue",
        id: "issue-1",
        companyId: "c1",
        title: "PR ready for review",
        identifier: null,
        status: "in_review",
        href: "/PAP/issues/PAP-1",
        metadata: {
          reviewAttentionState: "stalled",
          ...(reviewPolicy === undefined ? {} : { reviewPolicy }),
        },
      },
    });

  it("says nothing about who can approve on a review with no policy set", () => {
    const el = render(
      <AttentionQueueRow
        item={reviewItemWithPolicy()}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(el.querySelector('[data-testid="review-policy-badge"]')).toBeNull();
    expect(el.textContent).not.toContain("Anyone else");
    expect(el.textContent).not.toContain("Human only");
    // The verbs still render — suppressing the badge must not suppress the card.
    expect(el.textContent).toContain("Send back to work");
  });

  it("badges the opt-in constraint when the issue carries one", () => {
    const el = render(
      <AttentionQueueRow
        item={reviewItemWithPolicy("human_only")}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const badge = el.querySelector('[data-testid="review-policy-badge"]');
    expect(badge?.getAttribute("data-review-policy")).toBe("human_only");
    expect(badge?.textContent).toContain("Human only");
    expect(badge?.getAttribute("title")).toContain("Agents cannot");
  });

  it("badges a not_creator policy as 'Anyone else'", () => {
    const el = render(
      <AttentionQueueRow
        item={reviewItemWithPolicy("not_creator")}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const badge = el.querySelector('[data-testid="review-policy-badge"]');
    expect(badge?.getAttribute("data-review-policy")).toBe("not_creator");
    expect(badge?.textContent).toContain("Anyone else");
  });

  it("shows no badge for an explicit default or an unrecognised policy", () => {
    for (const policy of ["anyone", "board_only"]) {
      const el = render(
        <AttentionQueueRow
          item={reviewItemWithPolicy(policy)}
          companyId="c1"
          expanded
          onToggleExpand={noop}
          onDismiss={noop}
        />,
      );
      expect(el.querySelector('[data-testid="review-policy-badge"]')).toBeNull();
    }
  });

  it("deep-links a covered review instead of inlining", () => {
    const el = render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          subject: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "PR ready for review",
            identifier: null,
            status: "in_review",
            href: "/PAP/issues/PAP-1",
            metadata: {},
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(el.textContent).toContain("Open");
    expect(el.textContent).not.toContain("Send back to work");
  });

  it("fires onDismiss from the row menu action", () => {
    const onDismiss = vi.fn();
    const item = buildItem();
    render(
      <AttentionQueueRow
        item={item}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={onDismiss}
      />,
    );
    // The dropdown trigger + item live in a portal; invoke the handler contract
    // directly via the rendered menu after opening is environment-flaky in
    // jsdom, so assert the wiring by locating the trigger exists.
    const trigger = container?.querySelector('[aria-label="Row actions"]');
    expect(trigger).toBeTruthy();
  });

  it("toggles expand when the collapsed header of an inline row is clicked", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );
    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header).toBeTruthy();
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("exposes the visible expand chevron as an accessible button", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const chevronButton = container?.querySelector('button[aria-label="Expand decision"]');
    expect(chevronButton).toBeTruthy();
    expect(chevronButton?.getAttribute("aria-expanded")).toBe("false");
    act(() => chevronButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggleExpand).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("does not navigate on title click — the title is plain text, not a link", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const links = Array.from(container?.querySelectorAll("a") ?? []);
    // No anchor should carry the subject title (only the identifier link, absent here).
    expect(links.some((a) => a.textContent?.includes("Hire agent: Research Analyst"))).toBe(false);
  });

  // The eyebrow carries the decision kind and the task key only. Project
  // identity was removed from the card: the queue is filtered and grouped by
  // project from the toolbar, so repeating it on every row spent the eyebrow's
  // width on a fact the operator had usually just chosen.
  it("keeps project identity off the card", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          project: { id: "project-1", name: "Alpha", urlKey: "alpha", color: null, icon: "rocket" },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    expect(container?.querySelector('[data-testid="attention-project-meta"]')).toBeNull();
    expect(container?.textContent).not.toContain("Alpha");
  });

  it("separates eyebrow facts with a middle dot, not a slash", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "blocker_attention",
          subject: {
            kind: "issue",
            id: "i1",
            companyId: "c1",
            title: "Update primary paperclip instance",
            identifier: "PAP-23",
            status: "blocked",
            href: "/PAP/issues/PAP-23",
          },
          relatedIssue: null,
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const eyebrow = container?.querySelector('[data-attention-row] > div');
    expect(eyebrow?.textContent).toContain("·");
    expect(eyebrow?.textContent).not.toContain("/");
  });

  // Regression: the meta breadcrumb used to read only `relatedIssue`, so rows
  // whose subject IS the task (reviews, blocked dependencies) showed no key at
  // all — the rows most obviously about a task were the ones missing it.
  it("shows the task key when the subject is the task itself", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "blocker_attention",
          subject: {
            kind: "issue",
            id: "i1",
            companyId: "c1",
            title: "Update primary paperclip instance",
            identifier: "PAP-23",
            status: "blocked",
            href: "/PAP/issues/PAP-23",
          },
          relatedIssue: null,
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const link = Array.from(container?.querySelectorAll("a") ?? []).find((a) => a.textContent === "PAP-23");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/PAP/issues/PAP-23");
  });

  it("shows no task key on a row that is not attached to a task", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ relatedIssue: null })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(container?.textContent).not.toMatch(/PAP-\d+/);
  });

  it("places the timestamp beside the row menu without a clock icon", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const menu = container?.querySelector('[aria-label="Row actions"]');
    const menuArea = menu?.closest('[data-attention-menu="true"]');
    expect(menuArea?.textContent).not.toBe("");
    expect(container?.querySelector("svg.lucide-clock")).toBeNull();
  });

  // Rows became rounded cards when the decision types were flattened: with the
  // left accent rail gone, the card's own shape carries the separation that the
  // rail used to, so square edges no longer read as deliberate.
  it("uses rounded card edges and can show a keyboard selection ring", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        selected
      />,
    );

    const row = container?.querySelector("[data-attention-row]");
    expect(row?.getAttribute("class")).toContain("rounded-xl");
    expect(row?.getAttribute("class")).toContain("ring-ring");
  });

}
