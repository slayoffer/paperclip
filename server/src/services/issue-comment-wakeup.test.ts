import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commentWakeRequiresMarker,
  commentWakeSuppressed,
  isNoWakeComment,
  isWakeComment,
  shouldWakeAssigneeForIssueComment,
} from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });
});

describe("no-wake comment marker", () => {
  const base = {
    selfComment: false,
    resumeRequested: false,
    commentCreatedByRunId: null,
    issueAtCommentStart: { checkoutRunId: null, executionRunId: null },
    reopened: false,
    currentStatus: "blocked",
  };

  it("recognises the marker only at the start of the body", () => {
    expect(isNoWakeComment("[no-wake] status: still waiting on CI")).toBe(true);
    expect(isNoWakeComment("  \n[No-Wake] note")).toBe(true);
    expect(isNoWakeComment("please act; [no-wake] later")).toBe(false);
    expect(isNoWakeComment("")).toBe(false);
    expect(isNoWakeComment(undefined)).toBe(false);
  });

  it("does not wake the assignee for a no-wake comment", () => {
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true })).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: false })).toBe(true);
  });

  it("lets an explicit resume or reopen override the marker", () => {
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true, resumeRequested: true })).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...base, noWake: true, reopened: true })).toBe(true);
  });
});

describe("wake comment marker rule", () => {
  const agent = { type: "agent", source: "agent_jwt" };
  const apiKey = { type: "board", source: "board_key" };
  const mcp = { type: "board", source: "mcp_oauth" };
  const browser = { type: "board", source: "session" };
  const local = { type: "board", source: "local_implicit" };
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER;
    else process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER = saved;
  });

  it("recognises [wake] only at the start of the body", () => {
    expect(isWakeComment("[wake] decision: ship it")).toBe(true);
    expect(isWakeComment("  [WAKE] go")).toBe(true);
    expect(isWakeComment("note [wake]")).toBe(false);
    expect(isWakeComment("[no-wake] note")).toBe(false);
    expect(isWakeComment(null)).toBe(false);
  });

  it("is off unless the switch is exactly true", () => {
    delete process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER;
    expect(commentWakeRequiresMarker(agent)).toBe(false);
    expect(commentWakeSuppressed("plain status note", agent)).toBe(false);
    process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER = "1";
    expect(commentWakeSuppressed("plain status note", agent)).toBe(false);
  });

  it("keeps [no-wake] working with the switch off", () => {
    delete process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER;
    expect(commentWakeSuppressed("[no-wake] receipt", browser)).toBe(true);
  });

  it("with the switch on, suppresses unmarked comments from agents and non-browser board actors", () => {
    process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER = "true";
    for (const actor of [agent, apiKey, mcp, { type: "none" }]) {
      expect(commentWakeSuppressed("status: still waiting", actor)).toBe(true);
      expect(commentWakeSuppressed("[wake] decision: merge it", actor)).toBe(false);
      expect(commentWakeSuppressed("[no-wake] receipt", actor)).toBe(true);
    }
  });

  it("with the switch on, lets a person in the board UI wake without a marker", () => {
    process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER = "true";
    expect(commentWakeSuppressed("please look at this", browser)).toBe(false);
    expect(commentWakeSuppressed("please look at this", local)).toBe(false);
    expect(commentWakeSuppressed("[no-wake] fyi", browser)).toBe(true);
  });

  it("treats a missing actor as not requiring the marker", () => {
    process.env.PAPERCLIP_COMMENT_WAKE_REQUIRES_MARKER = "true";
    expect(commentWakeRequiresMarker(undefined)).toBe(false);
  });
});
