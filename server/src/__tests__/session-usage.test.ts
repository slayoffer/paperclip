import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { resolveCumulativeSessionUsage } from "../services/session-usage.js";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("ordinary Codex session usage", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-ordinary-session-usage-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  it("records per-run deltas across resumes and a fresh baseline after thread replacement", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ordinary sessions", issuePrefix: "DELTA" });
    // No owner-session setting or owner-project row is used.
    await db.insert(agents).values({ id: agentId, companyId, name: "Task runner", role: "engineer", adapterType: "codex_local" });
    let tick = 0;
    const turn = async (sessionId: string, input: number, cached: number, output: number) => {
      const runId = randomUUID();
      const parsed = parseCodexJsonl([
        JSON.stringify({ type: "thread.started", thread_id: sessionId }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }),
      ].join("\n"));
      expect(parsed.usageBasis).toBe("session_cumulative");
      const result = await resolveCumulativeSessionUsage(db, { agentId, runId, sessionId, rawUsage: parsed.usage });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", sessionIdAfter: sessionId,
        createdAt: new Date(Date.now() + tick++ * 1000), usageJson: {
          ...result.normalizedUsage, rawInputTokens: input, rawCachedInputTokens: cached, rawOutputTokens: output,
        } });
      return result;
    };
    const first = await turn("ordinary-a", 100, 80, 10);
    expect(first.normalizedUsage).toEqual({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 });
    const second = await turn("ordinary-a", 160, 120, 14);
    expect(second.normalizedUsage).toEqual({ inputTokens: 60, cachedInputTokens: 40, outputTokens: 4 });
    expect(second.derivedFromSessionTotals).toBe(true);
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", sessionIdAfter: "ordinary-a",
      createdAt: new Date(Date.now() + tick++ * 1000), usageJson: { rawInputTokens: 0, rawCachedInputTokens: 0, rawOutputTokens: 0 } });
    expect((await turn("ordinary-a", 200, 150, 20)).normalizedUsage)
      .toEqual({ inputTokens: 40, cachedInputTokens: 30, outputTokens: 6 });
    const replaced = await turn("ordinary-b", 30, 20, 2);
    expect(replaced.normalizedUsage).toEqual({ inputTokens: 30, cachedInputTokens: 20, outputTokens: 2 });
    expect(replaced.derivedFromSessionTotals).toBe(false);
    expect((await turn("ordinary-b", 50, 35, 5)).normalizedUsage)
      .toEqual({ inputTokens: 20, cachedInputTokens: 15, outputTokens: 3 });
  });
});
