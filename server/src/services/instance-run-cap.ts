/** Preserve the admission parser, including its uncapped fallback. */
export function maxRunningRunsCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PAPERCLIP_MAX_RUNNING_RUNS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

let processCap: Readonly<{ cap: number | null }> | undefined;

/** Capture after environment loading, before the first admission or health router. */
export function getProcessRunningRunsCap(): number | null {
  processCap ??= Object.freeze({ cap: maxRunningRunsCap() });
  return processCap.cap;
}
