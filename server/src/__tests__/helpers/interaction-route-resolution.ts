import type { Express } from "express";
import type { Server } from "node:http";
import { once } from "node:events";

const servers = new Set<Server>();
export async function createLoopbackServer(app: Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.add(server);
  await once(server, "listening");
  return server;
}
export async function closeRouteServers() {
  const closing = [...servers];
  servers.clear();
  await Promise.all(closing.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
}

export async function resolveMockInteraction(
  args: unknown[],
  interaction: Record<string, unknown>,
) {
  const mutationOptions = args[4] as {
    afterResolveInTransaction?: (
      tx: Record<string, unknown>,
      resolved: Record<string, unknown>,
    ) => Promise<void>;
  } | undefined;
  await mutationOptions?.afterResolveInTransaction?.({}, interaction);
  return interaction;
}

export function createMockIssue(assigneeAgentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: assigneeAgentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1714",
    title: "Persist interactions",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}
