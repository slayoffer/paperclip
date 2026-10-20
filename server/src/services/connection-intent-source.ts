import { conflict, forbidden, notFound } from "../errors.js";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import type { toolAccessService } from "./tool-access.js";
import { CONNECTABLE_APP_DEFINITIONS, getAvailableConnectionMethods, getAppStoreDefinition, type ToolApplication, type ToolConnection } from "@paperclipai/shared";

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceSlugForApplication(application: ToolApplication | undefined) {
  return text(application?.metadata?.sourceTemplateKey) ?? text(application?.metadata?.galleryKey);
}

export function sourceSlugForConnection(
  connection: ToolConnection,
  applications: ReadonlyMap<string, ToolApplication>,
) {
  const source = text(connection.config?.sourceTemplateKey)
    ?? text(connection.transportConfig?.sourceTemplateKey)
    ?? sourceSlugForApplication(applications.get(connection.applicationId));
  return source && getAppStoreDefinition(source) ? source : `connection:${connection.id}`;
}

export function availableToolConnectionMethods(
  app: (typeof CONNECTABLE_APP_DEFINITIONS)[number],
) {
  return getAvailableConnectionMethods(app).filter(
    (method) => (method.purpose ?? "tool") === "tool" && method.transport !== "runtime_auth",
  );
}

/** Probe before row locks because OAuth refresh can rotate the connection's secret. */
export async function checkUncheckedIntentConnection(
  access: ReturnType<typeof toolAccessService>,
  task: { companyId: string; assigneeAgentId: string | null; status: string },
  payload: ConnectionIntentInteraction["payload"],
  connectionId: string,
  userId: string,
  canManageOrganizationGrant = false,
) {
  if (task.assigneeAgentId !== payload.requestingAgentId || ["done", "cancelled"].includes(task.status)) {
    throw conflict("Connection request no longer belongs to an active task");
  }
  const candidate = await access.getConnection(connectionId, task.companyId);
  const application = await access.getApplication(candidate.applicationId, task.companyId);
  if (sourceSlugForConnection(candidate, new Map([[application.id, application]])) !== payload.serviceSlug) {
    throw notFound("Connection does not match this intent");
  }
  if (payload.purpose || candidate.connectionPurpose !== "tool" || candidate.status !== "active"
    || !candidate.enabled || candidate.healthStatus !== "unchecked") return;
  if (payload.accessRequest) {
    if (payload.accessRequest.connectionId !== connectionId) throw conflict("Use the connection named in this access request");
    if (!canManageOrganizationGrant) throw forbidden("Granting agent tool access requires connection-management authority");
  }
  const { grants } = await access.listConnectionGrants(connectionId, task.companyId);
  const personal = grants.some(grant => grant.status === "active" && (
    (grant.kind === "user" && grant.subjectUserId === userId)
    || (grant.kind === "agent" && grant.subjectAgentId === payload.requestingAgentId)
  ));
  if (!personal && !canManageOrganizationGrant) throw forbidden("Sharing a company connection requires connection-management authority");
  if (!personal && !grants.some(grant => grant.kind === "organization" && grant.status === "active")) {
    throw conflict("This connection has no usable identity grant");
  }
  await access.checkHealth(connectionId, { actorType: "user", actorId: userId });
}
