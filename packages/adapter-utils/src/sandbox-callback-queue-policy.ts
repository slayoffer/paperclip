export const SANDBOX_CALLBACK_QUEUE_V2_ENV = "PAPERCLIP_SANDBOX_CALLBACK_QUEUE_V2_ENABLED";

/** Control queue acknowledgement and expiry without changing worker deadlines. */
export function sandboxCallbackQueuePolicy(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: !["false", "0"].includes(env[SANDBOX_CALLBACK_QUEUE_V2_ENV]?.trim().toLowerCase() ?? ""),
  };
}
