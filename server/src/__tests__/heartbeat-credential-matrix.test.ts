import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { processAdapter } from "../adapters/process/index.js";
import { createRunSecretRedactionRegistry, preserveRunSecretRegistry } from "../services/run-secret-redaction.js";
import { redactRunPersistencePatch } from "../services/run-result-redaction.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { localSyntheticBridge, persistenceFixture } from "./helpers/credential-persistence-fixture.js";
import { executeSyntheticRemoteAcp } from "./helpers/acp-credential-persistence-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported && process.env.PAPERCLIP_REQUIRE_PERSISTENCE_REDACTION_TESTS === "1") throw new Error(support.reason ?? "Embedded Postgres is required");
(support.supported ? describe : describe.skip)("synthetic credential persistence matrix", () => {
  let fixture: Awaited<ReturnType<typeof persistenceFixture>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-matrix-signing-material-only");
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:1");
    fixture = await persistenceFixture();
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await fixture?.close(); vi.unstubAllEnvs(); });

  it("registers the remote ACP bridge value before transport exposure and masks persisted standalone output", async () => {
    const binding = await fixture.seed();
    let opaque = "";
    let registrationFinished = false;
    let adapterOutput = "";
    vi.spyOn(processAdapter, "execute").mockImplementation(async ctx => {
      const result = await executeSyntheticRemoteAcp({
        ...ctx,
        registerSecretValue: async value => {
          await ctx.registerSecretValue!(value);
          registrationFinished = true;
        },
      }, async value => {
        expect(registrationFinished).toBe(true);
        const values = await createRunSecretRedactionRegistry(fixture.db).valuesForRun(binding.companyId, ctx.runId);
        expect(values).toContain(value);
        opaque = value;
      });
      adapterOutput = result.summary ?? "";
      await fixture.complete(binding.issueId);
      return { ...result, resultJson: { ...result.resultJson, output: adapterOutput, neutral: 19 } };
    });
    const run = await fixture.start(binding);
    await fixture.heartbeat.drainActiveRunExecutions();
    const { row, log, reconstructed } = await fixture.read(run.id);
    expect(opaque).not.toBe("");
    expect(adapterOutput).toBe(opaque);
    expect(row.status).toBe("succeeded");
    expect(row.resultJson).toMatchObject({ output: "***REDACTED***", neutral: 19 });
    expect(reconstructed).toContain("neutral ACP output");
    expect(reconstructed).toContain("REDACTED");
    expect(JSON.stringify([row.resultJson, row.error, row.stdoutExcerpt, row.stderrExcerpt, log, reconstructed])).not.toContain(opaque);
  }, 60_000);

  for (const outcome of ["succeeded", "failed", "timed_out", "cancelled", "late_finalization"] as const) {
    it(`masks created bridge, run key, and header values for ${outcome}`, async () => {
      const binding = await fixture.seed();
      const secrets: string[] = [];
      let invoked = 0;
      const loggedErrors: unknown[] = [];
      vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => { loggedErrors.push(args); });
      vi.spyOn(processAdapter, "execute").mockImplementation(async ctx => {
        invoked++;
        const bridge = await localSyntheticBridge(ctx);
        try {
          expect(ctx.authToken).toBeTruthy();
          expect(ctx.runtimeTools?.bearerToken).toBeTruthy();
          const servers = ctx.runtimeMcp!.getServers();
          expect(servers.some(server => server.connectionId.startsWith("assignment:"))).toBe(true);
          secrets.push(...new Set([bridge.env.PAPERCLIP_API_KEY, ctx.authToken!, ctx.runtimeTools!.bearerToken, ...servers.map(server => server.token)]));
          const registry = createRunSecretRedactionRegistry(fixture.db);
          expect(await registry.valuesForRun(binding.companyId, ctx.runId)).toEqual(expect.arrayContaining(secrets));
          // Split every emitted secret across awaited callbacks, on both streams.
          for (const stream of ["stdout", "stderr"] as const) {
            for (const secret of secrets) {
              await ctx.onLog(stream, `neutral ${secret.slice(0, 11)}`);
              await ctx.onLog(stream, `${secret.slice(11)} done\n`);
              await ctx.onLog(stream, `Authorization: Bearer ${secret}\n`);
            }
          }
          await fixture.complete(binding.issueId);
          if (outcome === "cancelled" || outcome === "late_finalization") {
            await fixture.heartbeat.cancelRun(ctx.runId);
          }
          // The final unterminated line exercises failure/cancellation flushing.
          await ctx.onLog("stderr", `tail ${secrets[0]}`);
          const text = secrets.join(" ");
          const resultJson = { nested: [{ text, count: 12, ok: true, absent: null }], summary: "neutral result" };
          if (outcome === "late_finalization") throw new Error(`late error ${text}`);
          return { exitCode: outcome === "failed" ? 3 : 0, signal: null, timedOut: outcome === "timed_out",
            errorMessage: outcome === "succeeded" ? undefined : `failure ${text}`, resultJson, summary: `summary ${text}` };
        } finally { await bridge.close(); }
      });
      const run = await fixture.start(binding);
      await fixture.heartbeat.drainActiveRunExecutions();
      const { row, log, chunks, reconstructed } = await fixture.read(run.id);
      expect(invoked).toBe(1);
      expect(row.status).toBe(outcome === "late_finalization" ? "cancelled" : outcome);
      expect(chunks.length).toBeGreaterThan(0);
      for (const secret of secrets) {
        for (const text of [JSON.stringify(loggedErrors), JSON.stringify(row.resultJson), row.error ?? "", row.stdoutExcerpt ?? "", row.stderrExcerpt ?? "", log, reconstructed]) {
          expect(text).not.toContain(secret);
        }
      }
      expect(reconstructed).toContain("neutral");
      expect(reconstructed).toContain("tail");
      expect(reconstructed).toContain("REDACTED");
      if (["succeeded", "failed", "timed_out"].includes(outcome)) {
        expect(row.resultJson).toMatchObject({ nested: [{ count: 12, ok: true, absent: null }], summary: "neutral result" });
      }
      const patch = { resultJson: row.resultJson, error: row.error, stdoutExcerpt: row.stdoutExcerpt, stderrExcerpt: row.stderrExcerpt };
      expect(redactRunPersistencePatch(patch, secrets)).toEqual(patch);
    }, 60_000);
  }

  it("preserves early and concurrent registrations through context replacement", async () => {
    const binding = await fixture.seed();
    const early = "synthetic-early-opaque-8mV4q", concurrent = "synthetic-concurrent-opaque-9rT3k";
    vi.spyOn(processAdapter, "execute").mockImplementation(async ctx => {
      const registry = createRunSecretRedactionRegistry(fixture.db);
      expect(await registry.valuesForRun(binding.companyId, ctx.runId)).toEqual(expect.arrayContaining([early, concurrent]));
      await fixture.complete(binding.issueId);
      await ctx.onLog("stdout", `early ${early} concurrent ${concurrent}\n`);
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { output: `${early} ${concurrent}`, neutral: 7 } };
    });
    // Pause execution before its first context update, using the actual database registration path.
    const registry = createRunSecretRedactionRegistry(fixture.db);
    const run = await fixture.start(binding);
    await Promise.all([registry.register(binding.companyId, run.id, early), registry.register(binding.companyId, run.id, concurrent)]);
    await fixture.db.update(heartbeatRuns).set({ contextSnapshot: preserveRunSecretRegistry({ issueId: binding.issueId, neutral: true }) }).where(eq(heartbeatRuns.id, run.id));
    await fixture.heartbeat.drainActiveRunExecutions();
    const { row, log } = await fixture.read(run.id);
    expect(row.status).toBe("succeeded");
    expect(JSON.stringify([row.resultJson, row.stdoutExcerpt, log])).not.toContain(early);
    expect(JSON.stringify([row.resultJson, row.stdoutExcerpt, log])).not.toContain(concurrent);
    expect(await registry.valuesForRun(binding.companyId, run.id)).toEqual(expect.arrayContaining([early, concurrent]));
  }, 60_000);

  it("preserves types and valid JSON for large and deep persisted results", async () => {
    const binding = await fixture.seed();
    const opaque = "synthetic-large-opaque-5kJ9p";
    const board = `pcp_board_${"cd".repeat(24)}`;
    vi.spyOn(processAdapter, "execute").mockImplementation(async ctx => {
      await ctx.registerSecretValue!(opaque);
      await fixture.complete(binding.issueId);
      const leaf = { output: `${opaque} ${board}`, count: 42, yes: true, absent: null };
      let deep: unknown = leaf;
      for (let i = 0; i < 80; i++) deep = { next: deep };
      const large = `${"neutral ".repeat(20_000)}${opaque} ${board}`;
      await ctx.onLog("stdout", `${opaque.slice(0, 8)}`);
      await ctx.onLog("stdout", `${opaque.slice(8)}\n`);
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { leaf, array: [1, false, null, "neutral"], large, deep } };
    });
    const run = await fixture.start(binding);
    await fixture.heartbeat.drainActiveRunExecutions();
    const { row, log } = await fixture.read(run.id);
    expect(row.status).toBe("succeeded");
    const serialized = JSON.stringify(row.resultJson);
    expect(JSON.parse(serialized)).toEqual(row.resultJson);
    expect(row.resultJson).toMatchObject({ leaf: { count: 42, yes: true, absent: null }, array: [1, false, null, "neutral"] });
    expect(String(row.resultJson?.large)).toContain("neutral ".repeat(20_000));
    for (const value of [opaque, board]) expect(serialized + log).not.toContain(value);
    expect(redactRunPersistencePatch({ resultJson: row.resultJson }, [opaque])).toEqual({ resultJson: row.resultJson });
  }, 60_000);

});
