import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Baseline test skipped: ${support.reason}`);

suite("owner session baseline query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-session-baseline-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => { await database?.cleanup(); });

  it("counts resume fallback, unknown usage, company scope, and the seven-day boundary", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Baseline", issuePrefix: `B${companyId.replaceAll("-", "")}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `B${otherCompanyId.replaceAll("-", "")}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Codex", role: "engineer", adapterType: "codex_local" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer", adapterType: "codex_local" },
    ]);
    const run = (overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) => ({
      companyId, agentId, status: "succeeded",
      createdAt: new Date("2026-10-20T00:00:00Z"),
      sessionIdBefore: "thread-a", sessionIdAfter: "thread-a",
      usageJson: { inputTokens: 100, rawInputTokens: 999_999 },
      ...overrides,
    });
    await db.insert(heartbeatRuns).values([
      run(), run({ usageJson: { inputTokens: 300 } }),
      run({ sessionIdBefore: null, sessionIdAfter: "thread-b", usageJson: { inputTokens: 800 } }),
      run({ sessionIdAfter: "fallback-thread", usageJson: { inputTokens: 1_200 } }),
      run({ sessionIdAfter: null, usageJson: null, status: "failed" }),
      run({ sessionIdAfter: "", usageJson: { inputTokens: "bad" } }),
      run({ createdAt: new Date("2026-10-16T05:30:00Z"), usageJson: { inputTokens: 200 } }),
      run({ createdAt: new Date("2026-10-16T05:29:59Z") }),
      run({ createdAt: new Date("2026-10-23T05:30:00Z") }),
      run({ status: "running" }), run({ status: "queued" }),
      run({ companyId: otherCompanyId, agentId: otherAgentId }),
    ]);
    const template = await readFile(new URL("../../scripts/owner-session-baseline.sql", import.meta.url), "utf8");
    const query = template.replaceAll(":'company_id'", `'${companyId}'`)
      .replaceAll(":'window_end'", "'2026-10-23T05:30:00Z'");
    const rows = await db.execute(sql.raw(query));
    const codex = rows.filter(row => row.adapter_type === "codex_local");
    expect(codex).toHaveLength(3);
    const numbers = (state: string) => {
      const row = codex.find(row => row.resume_state === state)!;
      return [Number(row.runs), Number(row.token_samples), Number(row.median_input_tokens), Number(row.percent_of_terminal_runs)];
    };
    expect(numbers("resumed")).toEqual([3, 3, 200, 42.86]);
    expect(numbers("fresh")).toEqual([2, 2, 1_000, 28.57]);
    expect(numbers("unknown").slice(0, 2)).toEqual([2, 0]);
    const claude = rows.filter(row => row.adapter_type === "claude_local");
    expect(claude).toHaveLength(3);
    expect(claude.every(row => Number(row.runs) === 0 && row.median_input_tokens === null
      && row.percent_of_terminal_runs === null)).toBe(true);
  });

  it("measures Claude runs and excludes invalid token values from the median", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Claude baseline", issuePrefix: `B${companyId.replaceAll("-", "")}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Claude", role: "engineer", adapterType: "claude_local",
    });
    await db.insert(heartbeatRuns).values([100, 200, -1, "300", null].map(inputTokens => ({
      companyId, agentId, status: "succeeded",
      createdAt: new Date("2026-10-20T00:00:00Z"),
      sessionIdBefore: "claude-thread", sessionIdAfter: "claude-thread",
      usageJson: { inputTokens },
    })));
    const template = await readFile(new URL("../../scripts/owner-session-baseline.sql", import.meta.url), "utf8");
    const query = template.replaceAll(":'company_id'", `'${companyId}'`)
      .replaceAll(":'window_end'", "'2026-10-23T05:30:00Z'");
    const rows = await db.execute(sql.raw(query));
    const row = rows.find(row => row.adapter_type === "claude_local" && row.resume_state === "resumed")!;
    expect(Number(row.runs)).toBe(5);
    expect(Number(row.token_samples)).toBe(2);
    expect(Number(row.median_input_tokens)).toBe(150);
    expect(Number(row.percent_of_terminal_runs)).toBe(100);
  });
});
