/** Preserve only the controller-owned session scope and host identity. */
export function ownerSessionState(value: Record<string, unknown>): Record<string, unknown> {
  if (value.ownerSession !== true) return {};
  const result: Record<string, unknown> = { ownerSession: true };
  if (typeof value.ownerSessionIssueId === "string") result.ownerSessionIssueId = value.ownerSessionIssueId;
  const remote = value.remoteExecution;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return result;
  const saved = remote as Record<string, unknown>;
  if (saved.transport !== "ssh" || typeof saved.host !== "string" || typeof saved.username !== "string" ||
    typeof saved.remoteCwd !== "string" || !Number.isInteger(saved.port)) return result;
  result.remoteExecution = {
    transport: "ssh", host: saved.host, username: saved.username, port: saved.port, remoteCwd: saved.remoteCwd,
  };
  return result;
}
