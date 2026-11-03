import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { createDb, executionWorkspaces } from "@paperclipai/db";
import { expect, it } from "vitest";
import "../services/issue-terminal-workspaces.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { terminalWorkspaceFixture } from "./helpers/terminal-workspace-fixture.js";

it("closes a terminal worktree with a one-connection database pool", async () => {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-close-pool-");
  const db = createDb(database.connectionString, { maxConnections: 1 });
  const directories: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const f = await terminalWorkspaceFixture(db, directories);
    const workspace = await f.workspace();
    pending = issueService(db).update(f.issue.id, { status: "done" });
    await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Terminal cleanup held the only database connection")), 10_000); }),
    ]);
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
    expect(row.status).toBe("archived");
    expect(existsSync(workspace.cwd!)).toBe(false);
  } finally {
    clearTimeout(timer);
    await database.cleanup();
    await pending?.catch(() => {});
    await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}, 30_000);
