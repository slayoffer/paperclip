import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { bridgeFixture } from "./review-bridge-wait-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("review bridge parent completion", () => {
  const f = bridgeFixture();

  it.each([
    ["active", "blocked", false],
    ["expired", "blocked", true],
    ["absent", "blocked", true],
    ["external", "blocked", true],
    ["active", "in_progress", true],
  ] as const)("handles child completion with %s wait and %s parent", async (wait, status, wakes) => {
    if (wait === "expired") f.wait.until = new Date(Date.now() - 1000).toISOString();
    await f.db.update(issues).set({
      status,
      unblockDescriptor: wait === "absent" ? null
        : wait === "external" ? { kind: "external", owner: { agentId: f.agentId }, action: "Wait for a service." }
        : f.wait,
    }).where(eq(issues.id, f.issue.id));
    const [child] = await f.db.insert(issues).values({
      companyId: f.companyId, parentId: f.issue.id, title: "Review complete", status: "done",
    }).returning();

    const parent = await issueService(f.db).getWakeableParentAfterChildCompletion(f.issue.id);
    if (wakes) {
      expect(parent).toMatchObject({ id: f.issue.id, assigneeAgentId: f.agentId, childIssueIds: [child!.id] });
    } else {
      expect(parent).toBeNull();
      expect((await f.current()).unblockDescriptor).toEqual(f.wait);
    }
    expect((await f.current()).status).toBe(status);
  });
});
