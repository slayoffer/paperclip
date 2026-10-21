import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
  update: vi.fn(),
  updateGeneral: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  computeTaskDrain: vi.fn(),
  applyTaskDrain: vi.fn(),
  stopTaskDrain: vi.fn(),
  getTaskDrainStatus: vi.fn(),
}));
const mockTaskDrain = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  findManagedSandboxEnvironment: vi.fn(),
  update: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPublishActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/task-drain.js", () => ({ taskDrainService: () => mockTaskDrain }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => mockCompanyService,
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
    publishActivity: mockPublishActivity,
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

// Identity object the mocked db.transaction hands to writers; tests assert
// both the marker clear and the settings update receive THIS same tx.
const TX_SENTINEL = { __tx: true };
// Runs the callback with a sentinel tx and propagates throws, so a failing
// write inside rejects the whole request exactly like a real transaction
// rollback. This is the default mockDb.transaction implementation; a test
// that installs its own mockImplementation loses this default, so
// beforeEach below reinstalls it before every test.
function defaultTransactionImplementation(fn: (tx: unknown) => Promise<unknown>) {
  return fn(TX_SENTINEL);
}
// Module-scoped (not rebuilt per createApp call) so a test can assert how
// many times a request opened a transaction — the task-drain audit writes
// for every company must share ONE transaction, not one each.
// Rows the lifecycle read-back's plain `db.select().from(companies)` sees;
// tests assign per case.
let mockCompanyRows: Array<{ id: string; status: string }> = [];
const mockDb = {
  transaction: vi.fn(defaultTransactionImplementation),
  select: vi.fn(() => ({ from: () => Promise.resolve(mockCompanyRows) })),
};

describe("instance settings routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { instanceSettingsRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
    ]);
    return { errorHandler, instanceSettingsRoutes };
  });

  function createApp(actor: any) {
    const { errorHandler, instanceSettingsRoutes } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", instanceSettingsRoutes(mockDb as any));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks() clears recorded calls only; it does not remove a
    // mockImplementation a prior test installed. Reinstall the default here
    // so a stateful implementation from one test can never leak into the
    // next one.
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(defaultTransactionImplementation);
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockInstanceSettingsService.getExperimental.mockReset();
    mockInstanceSettingsService.update.mockReset();
    mockInstanceSettingsService.updateGeneral.mockReset();
    mockInstanceSettingsService.updateExperimental.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockHeartbeatService.computeTaskDrain.mockReset();
    mockHeartbeatService.applyTaskDrain.mockReset();
    mockHeartbeatService.stopTaskDrain.mockReset();
    mockHeartbeatService.getTaskDrainStatus.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.findManagedSandboxEnvironment.mockReset();
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue(null);
    mockEnvironmentService.update.mockReset();
    mockPublishActivity.mockReset();
    mockLogActivity.mockReset();
    // Mirrors the real logActivity: push a publication for the transaction
    // to publish once it commits, so route-level tests can prove publish
    // happens only after every company's write in the same request lands.
    mockLogActivity.mockImplementation((_db: unknown, input: { companyId: string }, postCommitPublications?: unknown[]) => {
      postCommitPublications?.push({ companyId: input.companyId, payload: input, pluginEvent: null });
      return Promise.resolve({ id: `activity-${input.companyId}` });
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      defaultEnvironmentId: null,
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
      experimental: {
        enableEnvironments: false,
        enableIsolatedWorkspaces: false,
        enableIssuePlanDecompositions: false,
        enableExperimentalFileViewer: false,
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableBetaSkills: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableBetaSkills: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    });
    mockInstanceSettingsService.update.mockResolvedValue({
      id: "instance-settings-1",
      defaultEnvironmentId: "env-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
      experimental: {
        enableEnvironments: true,
        enableIsolatedWorkspaces: true,
        enableIssuePlanDecompositions: true,
        enableExperimentalFileViewer: true,
        enableExternalObjects: false,
        enableBuiltInAgents: false,
        enableBetaSkills: false,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: false,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
      },
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T01:00:00.000Z",
    });
    mockInstanceSettingsService.updateGeneral.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: true,
        feedbackDataSharingPreference: "allowed",
      },
    });
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({
      id: "instance-settings-1",
      experimental: {
        enableEnvironments: true,
        enableIsolatedWorkspaces: true,
        enableIssuePlanDecompositions: true,
        enableExperimentalFileViewer: true,
        enableExternalObjects: false,
        enableBuiltInAgents: true,
        enableGoalsSidebarLink: false,
        enableServerInfoDebugView: true,
        autoRestartDevServerWhenIdle: false,
        enableWorkspaceBranchReconcileForward: true,
        enableWorkspaceDirtyQuarantineRepair: true,
        enableWorktreeRunExecution: false,
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      driver: "local",
      status: "active",
      config: {},
    });
  });

  it("allows local board users to read and update experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/experimental");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      enableEnvironments: false,
      enableIsolatedWorkspaces: false,
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableBuiltInAgents: false,
      enableBetaSkills: false,
      enableGoalsSidebarLink: false,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableIsolatedWorkspaces: true });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableIsolatedWorkspaces: true,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("does not expose the retired liveness auto-recovery endpoints", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview")
      .send({ lookbackHours: 24 })
      .expect(404);
    await request(app)
      .post("/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run")
      .send({ lookbackHours: 24 })
      .expect(404);
  });

  it.each([true, false])("allows only instance admins to change chat connector visibility (%s)", async (isInstanceAdmin) => {
    const app = createApp({ type: "board", userId: "user-1", source: "session", isInstanceAdmin, companyIds: ["company-1"] });
    const response = await request(app).patch("/api/instance/settings/experimental").send({ enableChatConnectors: true });
    expect(response.status).toBe(isInstanceAdmin ? 200 : 403);
    if (isInstanceAdmin) {
      expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({ enableChatConnectors: true });
      expect(mockLogActivity).toHaveBeenCalled();
    } else {
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    }
  });

  it("accepts the instance-wide Streamlined UI preference", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableStreamlinedUi: false })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableStreamlinedUi: false,
    });
  });

  it("strips server-managed worktree run execution fields before updating experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: "2026-07-10T12:00:00.000Z",
        worktreeRunExecutionActivationInstanceId: "copied-instance",
      })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableWorktreeRunExecution: true,
    });
  });

  it("allows local board users to read and update the instance default environment", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body.defaultEnvironmentId).toBeNull();

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.update).toHaveBeenCalledWith(
      { defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" },
      { db: TX_SENTINEL },
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("clears the managed-default stamp marker on an explicit tenant default write", async () => {
    // A tenant write of defaultEnvironmentId reclassifies the default as
    // tenant-chosen: the reconciliation stamp marker on the managed
    // sandbox row must not survive, or a later managed-sandbox-only
    // mode-off pass would mistake the tenant's choice for a stamp.
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue({
      id: "managed-env-1",
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
      metadata: { managedByPaperclip: true, managedDefaultStamped: true },
    });
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBe(200);
    expect(mockEnvironmentService.update).toHaveBeenCalledWith(
      "managed-env-1",
      { metadata: { managedByPaperclip: true } },
      { db: TX_SENTINEL },
    );
    // Both writes commit in ONE transaction — each receives the SAME tx —
    // so no partial failure can desync the stamp marker from the default
    // (neither a stale stamp on a tenant choice, nor a reconciliation
    // default that lost its marker and can never revert).
    expect(mockInstanceSettingsService.update).toHaveBeenCalledWith(
      { defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" },
      { db: TX_SENTINEL },
    );
  });

  it("aborts the whole request (no committed settings) when the stamp-marker clear fails inside the transaction", async () => {
    // The marker clear and the settings write share a transaction, so a
    // failure in either rolls the whole thing back — a real DB would
    // discard both; here the settings write is never even reached.
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue({
      id: "managed-env-1",
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
      metadata: { managedByPaperclip: true, managedDefaultStamped: true },
    });
    mockEnvironmentService.update.mockRejectedValue(new Error("metadata write failed"));
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(patchRes.status).toBeGreaterThanOrEqual(500);
    expect(mockInstanceSettingsService.update).not.toHaveBeenCalled();
  });

  it("rejects unknown defaultEnvironmentId values with 422", async () => {
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .patch("/api/instance/settings")
      .send({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Environment not found");
    expect(mockInstanceSettingsService.update).not.toHaveBeenCalled();
  });

  it("allows local board users to update guarded dev-server auto-restart", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ autoRestartDevServerWhenIdle: true })
      .expect(200);

    expect(
      mockInstanceSettingsService.updateExperimental.mock.calls.some(
        ([patch]) => patch?.autoRestartDevServerWhenIdle === true,
      ),
    ).toBe(true);
  });

  it("allows local board users to update external object detection", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableExternalObjects: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableExternalObjects: true,
    });
  });

  it("allows local board users to update built-in agents", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableBuiltInAgents: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableBuiltInAgents: true,
    });
  });

  it("allows local board users to update the goals sidebar link", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableGoalsSidebarLink: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableGoalsSidebarLink: true,
    });
  });

  it("allows local board users to update the server info debug view", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableServerInfoDebugView: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableServerInfoDebugView: true,
    });
  });

  it("allows local board users to update environment controls", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableEnvironments: true })
      .expect(200);

    expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
      enableEnvironments: true,
    });
  });

  it("allows non-admin board users with company access to read but not update experimental settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    await request(app).get("/api/instance/settings/experimental").expect(200);

    await request(app)
      .patch("/api/instance/settings/experimental")
      .send({ enableEnvironments: true })
      .expect(403);

    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
  });

  it("allows local board users to read and update general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const getRes = await request(app).get("/api/instance/settings/general");
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });

    const patchRes = await request(app)
      .patch("/api/instance/settings/general")
      .send({
        censorUsernameInLogs: true,
        feedbackDataSharingPreference: "allowed",
      });

    expect(patchRes.status).toBe(200);
    expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
      censorUsernameInLogs: true,
      feedbackDataSharingPreference: "allowed",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("allows non-admin board users to read general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
  });

  it("rejects signed-in users without company access from reading general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
      memberships: [],
    });

    const res = await request(app).get("/api/instance/settings/general");

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
  });

  it("rejects non-admin board users from updating general settings", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ censorUsernameInLogs: true });

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/instance/settings/general")
      .send({ feedbackDataSharingPreference: "not_allowed" });

    expect(res.status).toBe(403);
    expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
  });

  describe("executionMode floor on cloud-managed instances", () => {
    const adminActor = {
      type: "board",
      userId: "owner-1",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };

    beforeEach(() => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    });

    it("rejects a write that changes executionMode", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
        executionMode: "kubernetes",
      });
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "any" });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "execution_mode_platform_managed" });
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("rejects pinning executionMode when the platform left it unrestricted", async () => {
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes" });

      expect(res.status).toBe(403);
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("allows a same-value executionMode echo so full-object settings forms keep working", async () => {
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
        executionMode: "kubernetes",
      });
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes", censorUsernameInLogs: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
        executionMode: "kubernetes",
        censorUsernameInLogs: true,
      });
    });

    it("allows general-settings writes that do not touch executionMode", async () => {
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.getGeneral).not.toHaveBeenCalled();
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({ censorUsernameInLogs: true });
    });

    it("keeps executionMode writable on self-hosted instances", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      const app = await createApp({
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
      });

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ executionMode: "kubernetes" });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({ executionMode: "kubernetes" });
    });
  });

  describe("operator-hidden settings floor", () => {
    const adminActor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    };

    afterEach(() => {
      delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
    });

    it("rejects a write that changes a hidden general field", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.censorUsernameInLogs";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateGeneral).not.toHaveBeenCalled();
    });

    it("allows a same-value echo of a hidden general field", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.censorUsernameInLogs";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: false, feedbackDataSharingPreference: "allowed" });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateGeneral).toHaveBeenCalledWith({
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "allowed",
      });
    });

    it("deep-compares hidden backupRetention echoes instead of rejecting them", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.general.backupRetention";
      mockInstanceSettingsService.getGeneral.mockResolvedValue({
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
        backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      });
      const app = await createApp(adminActor);

      const echo = await request(app)
        .patch("/api/instance/settings/general")
        .send({ backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 } });
      expect(echo.status).toBe(200);

      const change = await request(app)
        .patch("/api/instance/settings/general")
        .send({ backupRetention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 1 } });
      expect(change.status).toBe(403);
      expect(change.body.details).toMatchObject({ code: "settings_operator_managed" });
    });

    it("rejects a write that changes a hidden experimental toggle", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.experimental.enableEnvironments";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });

    it("enforces a wildcard allowlist at the API and preserves hidden values", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS =
        "instance.experimental.*,!instance.experimental.enableIsolatedWorkspaces";
      const app = await createApp(adminActor);

      const rejected = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true, enableIsolatedWorkspaces: true });
      expect(rejected.status).toBe(403);
      expect(rejected.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();

      // Existing full-form clients may echo hidden values without changing them.
      const allowed = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: false, enableIsolatedWorkspaces: true });
      expect(allowed.status).toBe(200);
      expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
        enableEnvironments: false, enableIsolatedWorkspaces: true,
      });
    });

    it("does not let an allowlist exception bypass an explicit API restriction", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS =
        "instance.experimental.*,!instance.experimental.enableEnvironments,instance.experimental.enableEnvironments";
      const app = await createApp(adminActor);
      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true });
      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });

    it("allows writes to non-hidden experimental toggles while others are hidden", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS =
        "instance.experimental.enableEnvironments,instance.experimental.enableServerInfoDebugView";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableIsolatedWorkspaces: true });

      expect(res.status).toBe(200);
      expect(mockInstanceSettingsService.updateExperimental).toHaveBeenCalledWith({
        enableIsolatedWorkspaces: true,
      });
    });

    it("floors every experimental toggle when the whole Experimental page is hidden", async () => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.experimental";
      const app = await createApp(adminActor);

      const res = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableIsolatedWorkspaces: true });

      expect(res.status).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
      expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();
    });

    it("keeps every field writable when the env var is unset", async () => {
      const app = await createApp(adminActor);

      const general = await request(app)
        .patch("/api/instance/settings/general")
        .send({ censorUsernameInLogs: true });
      expect(general.status).toBe(200);

      const experimental = await request(app)
        .patch("/api/instance/settings/experimental")
        .send({ enableEnvironments: true });
      expect(experimental.status).toBe(200);
    });
  });

  describe("task drain", () => {
    const admin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true, companyIds: ["company-1"] };
    const lease = { leaseId: "bb8243bf-6760-443f-bd01-930d885bba4b", ownerId: "admin-1", startedAt: "2026-10-21T00:00:00.000Z", expiresAt: "2026-10-21T00:15:00.000Z" };

    beforeEach(() => {
      mockTaskDrain.acquire.mockReset().mockImplementation(async (_owner, _input, audit) => {
        await audit(TX_SENTINEL, lease);
        return lease;
      });
      mockTaskDrain.release.mockReset().mockImplementation(async (_owner, _id, audit) => {
        await audit(TX_SENTINEL, { wasActive: true });
        return { wasActive: true };
      });
    });

    it("awaits stored status", async () => {
      mockHeartbeatService.getTaskDrainStatus.mockResolvedValue({ draining: true, lease, persistedRunningRuns: 2, quiescent: false });
      const result = await request(createApp(admin)).get("/api/instance/task-drain");
      expect(result.status).toBe(200);
      expect(result.body.persistedRunningRuns).toBe(2);
    });

    it("acquires for the authenticated owner and audits each company in the lease transaction", async () => {
      const result = await request(createApp(admin)).post("/api/instance/task-drain").send({ ttlMs: 1000 });
      expect(result.status).toBe(200);
      expect(result.body).toEqual(lease);
      expect(mockTaskDrain.acquire).toHaveBeenCalledWith("admin-1", { ttlMs: 1000 }, expect.any(Function));
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      for (const call of mockLogActivity.mock.calls) {
        expect(call[0]).toBe(TX_SENTINEL);
        expect(call[1]).toMatchObject({ action: "instance.task_drain.started", details: lease });
      }
      expect(mockPublishActivity).toHaveBeenCalledTimes(2);
    });

    it("releases only the supplied lease with the authenticated owner", async () => {
      const result = await request(createApp(admin)).delete("/api/instance/task-drain").send({ leaseId: lease.leaseId });
      expect(result.status).toBe(200);
      expect(mockTaskDrain.release).toHaveBeenCalledWith("admin-1", lease.leaseId, expect.any(Function));
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      expect(mockHeartbeatService.stopTaskDrain).not.toHaveBeenCalled();
    });

    it.each([null, 0, -1, 86400001])("rejects invalid finite durations: %s", async (ttlMs) => {
      expect((await request(createApp(admin)).post("/api/instance/task-drain").send({ ttlMs })).status).toBe(400);
      expect(mockTaskDrain.acquire).not.toHaveBeenCalled();
    });

    it("requires the lease ID for release", async () => {
      expect((await request(createApp(admin)).delete("/api/instance/task-drain").send({})).status).toBe(400);
      expect(mockTaskDrain.release).not.toHaveBeenCalled();
    });

    it.each([
      { ...admin, isInstanceAdmin: false },
      { type: "agent", agentId: "agent-1", source: "agent_key", companyId: "company-1" },
    ])("rejects writes without instance administrator access", async (actor) => {
      expect((await request(createApp(actor)).post("/api/instance/task-drain").send({})).status).toBe(403);
      expect((await request(createApp(actor)).delete("/api/instance/task-drain").send({ leaseId: lease.leaseId })).status).toBe(403);
      expect(mockTaskDrain.acquire).not.toHaveBeenCalled();
      expect(mockTaskDrain.release).not.toHaveBeenCalled();
    });

    it("reports persistence failures without publication", async () => {
      mockTaskDrain.acquire.mockRejectedValue(new Error("storage unavailable"));
      expect((await request(createApp(admin)).post("/api/instance/task-drain").send({})).status).toBe(500);
      expect(mockPublishActivity).not.toHaveBeenCalled();
    });

    it("keeps a committed lease when activity publication fails", async () => {
      mockPublishActivity.mockImplementation(() => { throw new Error("publication unavailable"); });
      expect((await request(createApp(admin)).post("/api/instance/task-drain").send({})).status).toBe(200);
    });
  });

  describe("cloud lifecycle read-back and unarchive", () => {
    const STACK_ID = "stack-lifecycle-routes";
    const adminActor = {
      type: "board",
      userId: "paperclip-cloud",
      source: "cloud_control",
      isInstanceAdmin: true,
      companyIds: [],
    };
    const memberActor = {
      type: "board",
      userId: "member-1",
      source: "cloud_tenant",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    };
    // The pinned primary company id the routes derive from the stack id.
    let primaryId: string;

    beforeEach(async () => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
      process.env.PAPERCLIP_CLOUD_STACK_ID = STACK_ID;
      const { cloudTenantPrimaryCompanyId } = await vi.importActual<
        typeof import("../services/cloud-instance.js")
      >("../services/cloud-instance.js");
      primaryId = cloudTenantPrimaryCompanyId(STACK_ID);
      mockCompanyRows = [];
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      delete process.env.PAPERCLIP_CLOUD_STACK_ID;
    });

    it("reports the primary company status and how many other companies are not archived", async () => {
      mockCompanyRows = [
        { id: primaryId, status: "archived" },
        { id: "company-sibling-live", status: "active" },
        { id: "company-sibling-paused", status: "paused" },
        { id: "company-sibling-archived", status: "archived" },
      ];
      const app = await createApp(adminActor);

      const res = await request(app).get("/api/instance/lifecycle");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        primaryCompanyId: primaryId,
        primaryCompanyStatus: "archived",
        // paused counts: any non-archived sibling keeps the stack alive.
        otherUnarchivedCompanyCount: 2,
      });
    });

    it("reports a missing primary company without failing", async () => {
      mockCompanyRows = [{ id: "company-other", status: "active" }];
      const app = await createApp(adminActor);

      const res = await request(app).get("/api/instance/lifecycle");

      expect(res.status).toBe(200);
      expect(res.body.primaryCompanyStatus).toBe("missing");
    });

    it("hides the cross-company lifecycle summary from non-admin board members", async () => {
      mockCompanyRows = [{ id: primaryId, status: "archived" }];
      const app = await createApp(memberActor);

      const res = await request(app).get("/api/instance/lifecycle");

      expect(res.status).toBe(403);
    });

    it("answers 404 when the instance is not cloud-managed", async () => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
      delete process.env.PAPERCLIP_CLOUD_STACK_ID;
      const readRes = await request(await createApp(adminActor)).get("/api/instance/lifecycle");
      expect(readRes.status).toBe(404);

      // The admin gate runs first, so prove the 404 with an admin actor.
      const unarchiveRes = await request(await createApp(adminActor))
        .post("/api/instance/lifecycle/unarchive-primary")
        .send({});
      expect(unarchiveRes.status).toBe(404);
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("unarchives an archived primary company as a system actor", async () => {
      mockCompanyService.getById.mockResolvedValue({ id: "", status: "archived" });
      mockCompanyService.update.mockImplementation(async (id: string) => ({ id, status: "active" }));
      const app = await createApp(adminActor);

      const res = await request(app)
        .post("/api/instance/lifecycle/unarchive-primary")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "active", changed: true });
      expect(mockCompanyService.update).toHaveBeenCalledWith(
        primaryId,
        { status: "active" },
        { actorType: "system", actorId: "paperclip-cloud", agentId: null, runId: null },
      );
    });

    it("attributes a human admin's unarchive to that admin, not to Cloud", async () => {
      mockCompanyService.getById.mockResolvedValue({ id: "", status: "archived" });
      mockCompanyService.update.mockImplementation(async (id: string) => ({ id, status: "active" }));
      const humanAdmin = {
        type: "board",
        userId: "human-admin",
        source: "session",
        isInstanceAdmin: true,
        companyIds: ["company-1"],
      };
      const app = await createApp(humanAdmin);

      const res = await request(app)
        .post("/api/instance/lifecycle/unarchive-primary")
        .send({});

      expect(res.status).toBe(200);
      expect(mockCompanyService.update).toHaveBeenCalledWith(
        primaryId,
        { status: "active" },
        expect.objectContaining({ actorType: "user", actorId: "human-admin" }),
      );
    });

    it("is idempotent: an unarchived primary company reports changed:false", async () => {
      mockCompanyService.getById.mockResolvedValue({ id: "", status: "active" });
      const app = await createApp(adminActor);

      const res = await request(app)
        .post("/api/instance/lifecycle/unarchive-primary")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "active", changed: false });
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("requires instance admin rights to unarchive", async () => {
      const app = await createApp(memberActor);

      const res = await request(app)
        .post("/api/instance/lifecycle/unarchive-primary")
        .send({});

      expect(res.status).toBe(403);
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });
  });
});
