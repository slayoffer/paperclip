export const RUN_TOKEN_CAP = "run_token_cap" as const;
export type RunTokenCapMode = "off" | "dry_run" | "enforce";
export interface RunTokenCapReceipt {
  mode: Exclude<RunTokenCapMode, "off">;
  limit: number;
  inputTokens: number;
  boundary: "turn.completed";
}

export function readRunTokenCapConfig(env: NodeJS.ProcessEnv = process.env): {
  mode: Exclude<RunTokenCapMode, "off">; limit: number;
} | null {
  const mode = env.PAPERCLIP_RUN_TOKEN_CAP_MODE?.trim();
  const raw = env.PAPERCLIP_RUN_TOKEN_CAP_INPUT_TOKENS?.trim();
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  if ((mode !== "dry_run" && mode !== "enforce") || !Number.isSafeInteger(limit) || limit <= 0) return null;
  return { mode, limit };
}

export function isRunTokenCapStop(run: { status: string; resultJson?: unknown } | null | undefined): boolean {
  if (run?.status !== "succeeded") return false;
  const result = run.resultJson as Record<string, unknown> | null;
  return result?.stopReason === RUN_TOKEN_CAP;
}
