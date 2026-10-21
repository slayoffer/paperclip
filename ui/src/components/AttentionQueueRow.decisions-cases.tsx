import { expect, it, vi } from "vitest";
import { act, container, render, buildItem, noop } from "./AttentionQueueRow.test-helpers";
import { AttentionQueueRow } from "./AttentionQueueRow";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";

export function registerDecisionsCases() {
  it("renders collapsed inline decision verbs in a dedicated action bar with semantic variants", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          decisionVerbs: [
            { id: "approve", label: "Approve", description: null },
            { id: "reject", label: "Reject", description: null },
          ],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header?.textContent).not.toContain("Approve");
    expect(header?.textContent).not.toContain("Reject");

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    expect(decisionActions?.textContent).toContain("Approve");
    expect(decisionActions?.textContent).toContain("Reject");

    // The footer splits the row's last line: disclosure on the left, decision
    // verbs on the right, so the affirmative verb sits in the same place in
    // every row whether it is collapsed or expanded.
    const actionArea = decisionActions?.closest('[data-attention-actions="true"]');
    expect(actionArea?.getAttribute("class")).toContain("justify-between");
    expect(decisionActions?.parentElement?.getAttribute("class")).toContain("@xl:justify-end");

    const rowMenu = container?.querySelector('[aria-label="Row actions"]');
    expect(rowMenu?.closest('[data-attention-menu="true"]')).toBeTruthy();
    expect(rowMenu?.closest('[data-attention-actions="true"]')).toBeNull();

    const buttons = Array.from(decisionActions?.querySelectorAll("button") ?? []);
    expect(buttons.find((button) => button.textContent === "Approve")?.getAttribute("data-variant")).toBe(
      "default",
    );
    expect(buttons.find((button) => button.textContent === "Reject")?.getAttribute("data-variant")).toBe(
      "destructive",
    );
  });

  it("submits a compact approval without expanding the card and confirms it", async () => {
    const onToggleExpand = vi.fn();
    vi.mocked(approvalsApi.approve).mockResolvedValue({} as never);
    render(
      <AttentionQueueRow
        item={buildItem({
          decisionVerbs: [{ id: "approve", label: "Approve", description: null }],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const approve = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Approve",
    );
    act(() => approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approvalsApi.approve).toHaveBeenCalledWith("approval-1");
    expect(onToggleExpand).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Approval approved");
  });

  it("renders configured confirmation labels and accepts from the compact action area", async () => {
    const onToggleExpand = vi.fn();
    vi.mocked(issuesApi.acceptInteraction).mockResolvedValue({} as never);
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-1",
            companyId: "c1",
            title: "Plan approval",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-1",
            metadata: { kind: "request_confirmation", issueId: "issue-1", revision: "displayed-revision" },
          },
          decisionVerbs: [
            { id: "accept", label: "Approve plan", description: null },
            { id: "reject", label: "Request changes", description: null },
          ],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    expect(decisionActions?.textContent).toContain("Approve plan");
    expect(decisionActions?.textContent).toContain("Request changes");
    expect(Array.from(decisionActions?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Approve plan")?.getAttribute("data-variant")).toBe("default");
    expect(Array.from(decisionActions?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Request changes")?.getAttribute("data-variant")).toBe("outline");

    const approve = Array.from(decisionActions?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Approve plan",
    );
    act(() => approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(issuesApi.acceptInteraction).toHaveBeenCalledWith("issue-1", "interaction-1", { expectedRevision: "displayed-revision" });
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("opens the matching confirmation form when requesting changes from a compact action", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-1",
            companyId: "c1",
            title: "Plan approval",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-1",
            metadata: { kind: "request_confirmation", issueId: "issue-1" },
          },
          decisionVerbs: [{ id: "reject", label: "Request changes", description: null }],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const requestChanges = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Request changes",
    );
    act(() => requestChanges?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onToggleExpand).toHaveBeenCalledOnce();
    expect(issuesApi.rejectInteraction).not.toHaveBeenCalled();
  });

}
