import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { legacyControllerBootId, legacyControllerClaim } from "./legacy-controller-lease.js";
import { claimLegacyRestartRecovery, readLegacyRestartCheckpoint,
  saveLegacyRestartCheckpoint } from "./legacy-restart-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("restart checkpoint canonical issue binding", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let cwd: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-restart-binding-");
    db = createDb(temporary.connectionString);
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-restart-binding-"));
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  });
  const cases = [
    { kind: "snapshot-only", valid: true },
    { kind: "first-class-match", valid: true },
    { kind: "first-class-conflict", valid: false },
    { kind: "native-wins", valid: true },
    { kind: "native-conflict", valid: false },
    { kind: "snapshot-missing", valid: false },
  ];
  async function read(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }
  async function fixture(kind: string) {
    const companyId = randomUUID(), agentId = randomUUID();
    const issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restart binding", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "codex_local" });
    await db.insert(issues).values([issueId, otherIssueId].map(id => ({
      id, companyId, title: "Restart task", assigneeAgentId: agentId, status: "in_progress",
    })));
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      ...legacyControllerClaim("legacy"), executionStage: "dispatching",
      nativeIssueId: kind === "native-wins" ? issueId : kind === "native-conflict" ? otherIssueId : null,
      issueId: kind === "snapshot-only" ? null
        : ["first-class-conflict", "native-wins"].includes(kind) ? otherIssueId : issueId,
      contextSnapshot: kind === "snapshot-missing" ? {} : { issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issueId));
    return { run, issueId, otherIssueId };
  }
  function input() {
    return { adapterType: "codex_local", taskKey: null, workspaceCwd: cwd,
      sessionParams: { sessionId: "saved-provider-session", cwd } };
  }

  it.each(cases)("saves only a consistent snapshot: $kind", async ({ kind, valid }) => {
    const f = await fixture(kind);
    const run = f.run;
    await saveLegacyRestartCheckpoint(db, run, input());
    const saved = await read(run.id);
    if (valid) {
      expect(readLegacyRestartCheckpoint(saved)).toMatchObject({ issueId: f.issueId,
        executionWorkspaceId: null, sessionParams: { sessionId: "saved-provider-session", cwd } });
      expect(saved.sessionIdAfter).toBe("saved-provider-session");
    } else {
      expect(saved.resultJson?.restartCheckpoint).toBeUndefined();
      expect(saved.sessionIdAfter).toBeNull();
    }
  });

  it.each(cases)("checks persisted binding before reading and claiming a saved checkpoint: $kind", async ({ kind, valid }) => {
    const f = await fixture(kind);
    // Model a persisted historical checkpoint without changing the immutable run binding.
    await db.update(heartbeatRuns).set({
      sessionIdAfter: "saved-provider-session",
      resultJson: { restartCheckpoint: { version: 1, companyId: f.run.companyId,
        agentId: f.run.agentId, issueId: f.issueId, executionWorkspaceId: null,
        providerStopped: true, ...input() } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    const previousBoot = randomUUID();
    await db.update(heartbeatRuns).set({ controllerBootId: previousBoot,
      controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(heartbeatRuns.id, f.run.id));
    const expired = await read(f.run.id);
    expect(Boolean(readLegacyRestartCheckpoint(expired))).toBe(valid);
    const claimed = await claimLegacyRestartRecovery(db, expired, "codex_local");
    const saved = await read(f.run.id);
    if (valid) {
      expect(claimed).toMatchObject({ issueId: f.issueId,
        sessionParams: { sessionId: "saved-provider-session", cwd } });
      expect(saved.controllerBootId).toBe(legacyControllerBootId);
      expect(saved.resultJson?.restartRecovery).toMatchObject({ outcome: "resuming", attempt: 1 });
    } else {
      expect(claimed).toBeNull();
      expect(saved.controllerBootId).toBe(previousBoot);
      expect(saved.resultJson?.restartRecovery).toMatchObject({ outcome: "reconciliation", reason: "restart_session_missing" });
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ executionRunId: f.run.id, checkoutRunId: f.run.id });
  });
});
