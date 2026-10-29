import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  getRunOutputRedactor,
  heartbeatRuns,
  setRunOutputRedactor,
} from "@paperclipai/db";
import {
  installRunOutputRedaction,
  redactRunLogText,
  redactRunResultSecrets,
} from "../services/run-result-redaction.ts";
import { workspaceOperationService } from "../services/workspace-operations.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// SYNA-1586. Synthetic, token-shaped values only. They are built at run time so that no literal token is in the file.
const GHO = `gho_${"F4ke0Tok3n".repeat(4)}`;
const GHP = `ghp_${"N0tR3alPat".repeat(4)}`;
const FINE_PAT = `github_pat_11${"FAKE0".repeat(4)}_${"f4keFineGrained".repeat(4)}`;
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlLXJ1biJ9", "ZmFrZS1zaWduYXR1cmUtbm90LXJlYWw"].join(".");
const PCGW = `pcgw_${randomUUID()}.${"Fk3Gw".repeat(9)}`;
const OPAQUE_KEY = "fake-opaque-run-key-Q7w9e2r4t6y8";
const SHAPED = [GHO, GHP, FINE_PAT, JWT, PCGW];
// An opaque key has no shape: the column encoder masks it only after a credential name. A bare opaque value needs the
// run registry (heartbeat-run-persistence-redaction.test.ts).
const SECRETS = [...SHAPED, OPAQUE_KEY];

// Neutral data that looks close to a credential and must stay visible.
const NEUTRAL = [
  "pcgw_1a2b3c4d", "pcgw_...", "tokens: 1234", "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  "token: see below", "GITHUB_TOKEN_URL: https://example.test/x", "PAPERCLIP_API_KEY: required",
];

const API_KEY_FORMS = [
  `PAPERCLIP_API_KEY=${OPAQUE_KEY}`,
  `export PAPERCLIP_API_KEY="${OPAQUE_KEY}"`,
  `env PAPERCLIP_API_KEY=${OPAQUE_KEY} PAPERCLIP_API_URL=http://127.0.0.1:3100 node agent.js`,
  `{"PAPERCLIP_API_KEY":"${OPAQUE_KEY}"}`,
  `PAPERCLIP_API_KEY: ${OPAQUE_KEY}`,
];

function expectClean(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("run output redaction policy (result_json and run log)", () => {
  it.each([
    ["gho_", GHO],
    ["ghp_", GHP],
    ["github_pat_", FINE_PAT],
    ["JWT", JWT],
    ["pcgw_ gateway token", PCGW],
  ])("masks a bare %s value in text, nested JSON, escaped JSON and a long run", (_name, secret) => {
    const long = `${"x".repeat(1100)}${secret}${"y".repeat(40)}`;
    const inputs = [`value ${secret} end`, JSON.stringify({ stdout: `got ${secret}` }), long];
    for (const input of inputs) {
      expect(redactRunLogText(input)).not.toContain(secret);
      expect(JSON.stringify(redactRunResultSecrets({ stdout: input }))).not.toContain(secret);
    }
    const nested = redactRunResultSecrets({ a: [{ b: { c: `print ${secret}` } }] });
    expect(JSON.stringify(nested)).not.toContain(secret);
  });

  it.each(API_KEY_FORMS)("masks the PAPERCLIP_API_KEY value in %s", (form) => {
    expect(redactRunLogText(form)).not.toContain(OPAQUE_KEY);
    expect(redactRunLogText(form)).toContain("PAPERCLIP_API_KEY");
    expect(JSON.stringify(redactRunResultSecrets({ stdout: form }))).not.toContain(OPAQUE_KEY);
  });

  it("masks PAPERCLIP_API_KEY under an env key and inside a long run", () => {
    const env = redactRunResultSecrets({ env: { PAPERCLIP_API_KEY: OPAQUE_KEY, PAPERCLIP_API_URL: "http://127.0.0.1:3100" } });
    expect(env).toEqual({ env: { PAPERCLIP_API_KEY: "***REDACTED***", PAPERCLIP_API_URL: "http://127.0.0.1:3100" } });
    const long = `${"z".repeat(1100)};PAPERCLIP_API_KEY=${OPAQUE_KEY}`;
    expect(redactRunLogText(long)).not.toContain(OPAQUE_KEY);
  });

  it("keeps neutral data, valid JSON and repeat application", () => {
    const value = { notes: NEUTRAL, count: 3, ok: true, none: null };
    expect(redactRunResultSecrets(value)).toEqual(value);
    for (const item of NEUTRAL) expect(redactRunLogText(item)).toBe(item);
    const once = redactRunResultSecrets({ stdout: [...SHAPED, ...API_KEY_FORMS].join("\n") });
    expect(redactRunResultSecrets(once)).toEqual(once);
    expect(() => JSON.parse(JSON.stringify(once))).not.toThrow();
  });

  it("installs the policy as the db column encoder", () => {
    setRunOutputRedactor(null);
    installRunOutputRedaction();
    const redactor = getRunOutputRedactor();
    expect(redactor).not.toBeNull();
    expect(redactor!.text(`token ${GHO}`)).not.toContain(GHO);
    expect(JSON.stringify(redactor!.json({ out: PCGW }))).not.toContain(PCGW);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.PAPERCLIP_REQUIRE_PERSISTENCE_REDACTION_TESTS === "1") {
  throw new Error(support.reason ?? "Embedded Postgres is required");
}

(support.supported ? describe : describe.skip)("heartbeat_runs output columns redact on every write path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let logRoot = "";
  let previousLogRoot: string | undefined;
  const leak = `stdout ${SHAPED.join(" ")}\n${API_KEY_FORMS.join("\n")}\n${NEUTRAL.join("\n")}`;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-output-column-redaction-");
    db = createDb(tempDb.connectionString);
    logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-output-column-redaction-logs-"));
    previousLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = logRoot;
    installRunOutputRedaction();
  }, 60_000);

  afterAll(async () => {
    installRunOutputRedaction();
    if (previousLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = previousLogRoot;
    await fs.rm(logRoot, { recursive: true, force: true });
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Column redaction", issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running",
      resultJson: { stdout: leak }, error: leak, stdoutExcerpt: leak, stderrExcerpt: leak,
    }).returning({ id: heartbeatRuns.id });
    return { companyId, runId: run!.id };
  }

  // Read the stored text, not the decoded row: this is what pg_dump and backups receive.
  async function storedText(runId: string) {
    const rows = await db.execute(sql`select result_json::text as result, error, stdout_excerpt, stderr_excerpt
      from heartbeat_runs where id = ${runId}`);
    const row = rows[0] as Record<string, string | null>;
    expect(() => JSON.parse(row.result ?? "null")).not.toThrow();
    return JSON.stringify(row);
  }

  it("redacts an insert from a writer that does not call the redactor", async () => {
    const { runId } = await seedRun();
    const text = await storedText(runId);
    expectClean(text);
    for (const item of NEUTRAL) expect(text).toContain(item);
    expect(text).toContain("PAPERCLIP_API_KEY");
  });

  it("redacts update().set() and a sql.param merge into result_json", async () => {
    const { runId } = await seedRun();
    await db.update(heartbeatRuns).set({ resultJson: { nested: [{ out: leak }] }, error: `failed: ${leak}` })
      .where(eq(heartbeatRuns.id, runId));
    expectClean(await storedText(runId));
    await db.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${sql.param({ merged: leak }, heartbeatRuns.resultJson)}::jsonb`,
      error: sql`coalesce(null, ${sql.param(leak, heartbeatRuns.error)})`,
    }).where(eq(heartbeatRuns.id, runId));
    const text = await storedText(runId);
    expectClean(text);
    expect(text).toContain("merged");
  });

  it("stores the value as written when no redactor is installed (the column type is the mechanism)", async () => {
    setRunOutputRedactor(null);
    try {
      const { runId } = await seedRun();
      expect(await storedText(runId)).toContain(GHO);
    } finally {
      installRunOutputRedaction();
    }
  });

  it("redacts workspace operation excerpts and the operation log", async () => {
    const { companyId, runId } = await seedRun();
    const service = workspaceOperationService(db);
    const operation = await service.createRecorder({ companyId, heartbeatRunId: runId }).recordOperation({
      phase: "worktree_prepare",
      command: "git clone",
      run: async () => ({ status: "succeeded", exitCode: 0, stdout: leak, stderr: leak }),
    });
    expectClean(JSON.stringify([operation.stdoutExcerpt, operation.stderrExcerpt]));
    expect(operation.stdoutExcerpt).toContain("stdout ");
    const log = await service.readLog(operation.id, { limitBytes: 1_000_000 });
    expectClean(JSON.stringify(log));
  });
});
