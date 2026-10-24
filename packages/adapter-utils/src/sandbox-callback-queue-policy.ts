export const SANDBOX_CALLBACK_QUEUE_V2_ENV = "PAPERCLIP_SANDBOX_CALLBACK_QUEUE_V2_ENABLED";

/** Keep the worker deadline inside the gateway deadline, with time for a receipt. */
export function sandboxCallbackQueuePolicy(env: NodeJS.ProcessEnv = process.env) {
  const enabled = !["false", "0"].includes(env[SANDBOX_CALLBACK_QUEUE_V2_ENV]?.trim().toLowerCase() ?? "");
  return {
    enabled,
    controlTimeoutMs: enabled ? 30_000 : 10_000,
    requestTimeoutMs: enabled ? 90_000 : 10_000,
    watchdogTimeoutMs: enabled ? 100_000 : 20_000,
    responseTimeoutMs: enabled ? 120_000 : 30_000,
  };
}
