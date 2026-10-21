import { confirmSshInPlaceTermination } from "./ssh-in-place-termination.js";
import { canonicalSshInPlaceLockKey } from "./ssh-in-place-workspace.js";
import type { Db } from "@paperclipai/db";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import { logger } from "../middleware/logger.js";
import { environmentService } from "./environments.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { classifyEnvironmentCapabilities, type EnvironmentRuntimeDriver } from "./environment-runtime.js";
import { ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT } from "./environment-driver-traits.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";
import { decideSshInPlaceRealization } from "./ssh-in-place-workspace.js";
import { sshInPlaceLockChecks } from "./ssh-in-place-lock-checks.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createSshEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "ssh",

    async acquireRunLease(input) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "ssh",
        providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          host: parsed.config.host,
          port: parsed.config.port,
          username: parsed.config.username,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
        },
      });
    },

    async releaseRunLease(input) {
      const stopped = await confirmSshInPlaceTermination(db, input.environment, input.lease, input.status);
      return stopped ?? await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const leaseRemoteCwd =
        typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
          ? input.lease.metadata.remoteCwd.trim()
          : null;
      const rawRequest = input.workspace.metadata?.workspaceRealizationRequest;
      const request: Record<string, unknown> = isRecord(rawRequest) ? rawRequest : {};
      const runId = input.lease.heartbeatRunId ??
        (typeof request.heartbeatRunId === "string" ? request.heartbeatRunId : null);
      const decision = await decideSshInPlaceRealization({
        environmentId: input.environment.id,
        adapterType: typeof request.adapterType === "string" ? request.adapterType : null,
        localPath: input.workspace.localPath,
        remoteCwd: leaseRemoteCwd ?? input.workspace.remotePath,
        leaseId: input.lease.id,
        runId,
        resolveConfig: async () => {
          const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, input.environment, {
            issueId: input.lease.issueId,
            heartbeatRunId: input.lease.heartbeatRunId,
          });
          if (parsed.driver !== "ssh") {
            throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
          }
          return parsed.config;
        },
        ...sshInPlaceLockChecks(db, input.lease.companyId, async (lease) =>
          await confirmSshInPlaceTermination(db, input.environment, lease, "released")),
      });
      if (decision.mode === "in_place") {
        const metadata = { ...input.lease.metadata, sshInPlaceWriter: {
          key: await canonicalSshInPlaceLockKey(decision.authoritativeRoot),
          remoteCwd: leaseRemoteCwd,
        } };
        if (!await environmentsSvc.updateLeaseMetadata(input.lease.id, metadata)) {
          throw new Error("SSH writer tracking could not be saved.");
        }
        input.lease.metadata = metadata;
        // Same-host in_place: the run works in the server's worktree at the
        // same absolute path. No copy, no restore. Runtime assets go to a
        // per-run folder outside the worktree.
        const record = buildWorkspaceRealizationRecordFromDriverInput({
          environment: input.environment,
          lease: input.lease,
          workspace: input.workspace,
          cwd: decision.authoritativeRoot,
          providerMetadata: {
            remoteCwd: decision.authoritativeRoot,
            workspaceRealization: {
              mode: "in_place",
              authoritativeRoot: decision.authoritativeRoot,
              runtimeRoot: decision.runtimeRoot,
            },
          },
        });
        logger.info(
          {
            environmentId: input.environment.id,
            leaseId: input.lease.id,
            heartbeatRunId: runId,
            authoritativeRoot: decision.authoritativeRoot,
            runtimeRoot: decision.runtimeRoot,
          },
          "SSH workspace realized in place on the shared host path",
        );
        return {
          cwd: decision.authoritativeRoot,
          metadata: {
            workspaceRealization: record,
          },
        };
      }
      if (decision.warn) {
        logger.warn(
          {
            environmentId: input.environment.id,
            leaseId: input.lease.id,
            heartbeatRunId: runId,
            localPath: input.workspace.localPath ?? null,
            reason: decision.reason,
          },
          "SSH same-host in_place is enabled for this environment, but this run uses the copy mode",
        );
      }
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: leaseRemoteCwd ?? input.workspace.remotePath ?? input.workspace.localPath ?? null,
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },

    async resolveCapabilities() {
      // The SSH driver runs commands on a remote host through the SSH
      // transport with no provider capability model, so it supports none of
      // the eight capabilities either.
      return classifyEnvironmentCapabilities({
        supportedCapabilities: ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT.ssh.supportedCapabilities,
      });
    },
  };
}
