import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { pauseAgentSchema } from "@paperclipai/shared";
import { agentService } from "../services/agents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("agent pause reason persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-pause-reason-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause test", issuePrefix: "PAU" });
  }, 30_000);

  afterAll(async () => { await database?.cleanup(); });

  it.each([
    { body: { reason: "ops-guard:quota-blip" }, expected: "ops-guard:quota-blip" },
    { body: undefined, expected: "manual" },
    { body: {}, expected: "manual" },
  ])("stores $expected and clears it on resume", async ({ body, expected }) => {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: "Builder", role: "engineer", status: "idle" });
    const service = agentService(db);
    const { reason } = pauseAgentSchema.parse(body);
    expect(await service.pause(id, reason)).toMatchObject({ status: "paused", pauseReason: expected });

    const [paused] = await db.select().from(agents).where(eq(agents.id, id));
    expect(paused).toMatchObject({ status: "paused", pauseReason: expected, pausedAt: expect.any(Date) });

    await service.resume(id);
    const [resumed] = await db.select().from(agents).where(eq(agents.id, id));
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });
  });
});
