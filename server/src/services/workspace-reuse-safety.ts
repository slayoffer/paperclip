import fs from "node:fs/promises";
import { and, eq, ne } from "drizzle-orm";
import { executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";

/** Inspect foreign workspace contents before restore can change Git state. */
export async function assertWorkspaceReuseIsSafe(input: {
  db?: Db | null;
  companyId: string;
  cwd: string;
  executionWorkspaceId?: string | null;
  sourceIssueId?: string | null;
  issueId?: string | null;
}): Promise<void> {
  if (!input.issueId || input.sourceIssueId === input.issueId) return;
  let sourceIssueId = input.sourceIssueId;
  if (!sourceIssueId && input.db) {
    const candidates = await input.db.select({
      sourceIssueId: executionWorkspaces.sourceIssueId,
      linkedIssueId: issues.id,
      cwd: executionWorkspaces.cwd,
      providerRef: executionWorkspaces.providerRef,
    }).from(executionWorkspaces).leftJoin(issues, and(
      eq(issues.companyId, input.companyId),
      eq(issues.executionWorkspaceId, executionWorkspaces.id),
      ne(issues.id, input.issueId),
    )).where(eq(executionWorkspaces.companyId, input.companyId));
    // Git can return a canonical path while the saved path contains a symlink.
    // Resolve both paths before selecting owners. Cache only within this check.
    const identities = new Map<string, Promise<string>>();
    function identity(value: string) {
      let resolved = identities.get(value);
      if (!resolved) {
        resolved = fs.realpath(value).catch(() => value);
        identities.set(value, resolved);
      }
      return resolved;
    }
    const cwdIdentity = await identity(input.cwd);
    const owners: typeof candidates = [];
    for (const candidate of candidates) {
      for (const value of [candidate.cwd, candidate.providerRef]) {
        if (value && await identity(value) === cwdIdentity) {
          owners.push(candidate);
          break;
        }
      }
    }
    // The original owner can resume even when other issues link to its row.
    if (owners.some((owner) => owner.sourceIssueId === input.issueId)) return;
    sourceIssueId = owners.find((owner) => owner.sourceIssueId)?.sourceIssueId
      ?? owners.find((owner) => owner.linkedIssueId)?.linkedIssueId;
  }
  if (!sourceIssueId) return;
  let cleanliness = "unknown";
  try {
    const { stdout } = await workspaceGitOperationScheduler.run({
      workspacePath: input.cwd,
      args: ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      operation: "workspace_runtime.cross_issue_reuse_guard",
      fairnessKeys: [`issue:${input.issueId}`, `issue:${sourceIssueId}`],
      cacheTtlMs: 0,
    });
    if (!stdout.trim()) return;
    cleanliness = "dirty";
  } catch {
    // A failed inspection cannot establish that another issue's files are safe.
  }
  const error = new Error(
    "Cannot reuse another issue's workspace. Its Git status is not clean. Select a separate workspace.",
  );
  throw Object.assign(error, {
    code: "workspace_validation_failed",
    resultJson: { workspaceValidation: {
      reason: "cross_issue_workspace_not_clean",
      cleanliness,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      sourceIssueId,
      issueId: input.issueId,
    } },
  });
}
