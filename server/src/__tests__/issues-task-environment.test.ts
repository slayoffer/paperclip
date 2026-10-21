import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, instanceSettings } from "@paperclipai/db";
import { clearCompanyFixtures } from "./helpers/clear-company-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const macId = "18371c35-0974-424d-aa10-fd08096e27aa";
const networkEgress = { allowFqdns: ["example.invalid"], allowCidrs: [] };
const requestedSettings = {
  environmentId: macId,
  networkEgress,
  mode: "isolated_workspace" as const,
  workspaceStrategy: { type: "git_worktree" as const },
  workspaceRuntime: { setupCommand: "exit 1" },
  sharedWorkspaceConcurrency: "serialize" as const,
};

suite("issue task environment persistence", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("issue-task-environment-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    await clearCompanyFixtures(db);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function fixture(enabled = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Routing", issuePrefix: "ENV", defaultResponsibleUserId: "owner",
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: enabled });
    return { companyId, service: issueService(db) };
  }

  it("preserves environment settings on create when isolated workspaces are disabled", async () => {
    const { companyId, service } = await fixture();
    const created = await service.create(companyId, {
      title: "Select Mac", status: "todo", priority: "medium",
      executionWorkspaceId: randomUUID(), executionWorkspacePreference: "create_new",
      executionWorkspaceSettings: requestedSettings,
    });
    expect(created.executionWorkspaceSettings).toEqual({ environmentId: macId, networkEgress });
    expect(created.executionWorkspaceId).toBeNull();
    expect(created.executionWorkspacePreference).toBeNull();
    expect((await service.getById(created.id))?.executionWorkspaceSettings).toEqual({ environmentId: macId, networkEgress });
  });

  it("preserves environment settings on update when isolated workspaces are disabled", async () => {
    const { companyId, service } = await fixture();
    const created = await service.create(companyId, { title: "Default", status: "todo", priority: "medium" });
    const updated = await service.update(created.id, {
      executionWorkspaceId: randomUUID(), executionWorkspacePreference: "create_new",
      executionWorkspaceSettings: requestedSettings,
    });
    expect(updated?.executionWorkspaceSettings).toEqual({ environmentId: macId, networkEgress });
    expect(updated?.executionWorkspaceId).toBeNull();
    expect(updated?.executionWorkspacePreference).toBeNull();
    expect((await service.getById(created.id))?.executionWorkspaceSettings).toEqual({ environmentId: macId, networkEgress });
  });

  it("preserves the enabled feature behavior", async () => {
    const { companyId, service } = await fixture(true);
    const settings = { mode: "shared_workspace" as const, environmentId: macId };
    const created = await service.create(companyId, {
      title: "Enabled control", status: "todo", priority: "medium", executionWorkspaceSettings: settings,
    });
    expect(created.executionWorkspaceSettings).toEqual(settings);
    expect((await service.update(created.id, { executionWorkspaceSettings: settings }))?.executionWorkspaceSettings).toEqual(settings);
  });

  it("retains the selection on an unrelated update and clears an explicit null selection", async () => {
    const { companyId, service } = await fixture();
    const created = await service.create(companyId, {
      title: "Selected", status: "todo", priority: "medium", executionWorkspaceSettings: { environmentId: macId },
    });
    expect((await service.update(created.id, { title: "Renamed" }))?.executionWorkspaceSettings).toEqual({ environmentId: macId });
    expect((await service.update(created.id, {
      executionWorkspaceSettings: { environmentId: null },
    }))?.executionWorkspaceSettings).toEqual({ environmentId: null });
    expect((await service.update(created.id, {
      executionWorkspaceSettings: null,
    }))?.executionWorkspaceSettings).toBeNull();
  });

  it("removes isolated controls without a task environment selection", async () => {
    const { companyId, service } = await fixture();
    const settings = { mode: "isolated_workspace" as const, workspaceRuntime: { setupCommand: "exit 1" } };
    const created = await service.create(companyId, {
      title: "No selection", status: "todo", priority: "medium", executionWorkspaceSettings: settings,
    });
    expect(created.executionWorkspaceSettings).toBeNull();
    expect((await service.update(created.id, { executionWorkspaceSettings: settings }))?.executionWorkspaceSettings).toBeNull();
  });

  it.each(["create", "update"])("rejects an invalid environment identifier during %s when isolated workspaces are disabled", async (operation) => {
    const { companyId, service } = await fixture();
    const settings = { environmentId: "invalid-environment" };
    const created = await service.create(companyId, { title: "Unchanged", status: "todo", priority: "medium" });
    const save = operation === "create"
      ? service.create(companyId, { title: "Invalid", status: "todo", priority: "medium", executionWorkspaceSettings: settings })
      : service.update(created.id, { executionWorkspaceSettings: settings });
    await expect(save).rejects.toThrow();
    expect((await service.getById(created.id))?.executionWorkspaceSettings).toBeNull();
  });
});
