const CODEX_ROLLOUT_NOISE_RE =
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i;

export function stripCodexRolloutNoise(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (CODEX_ROLLOUT_NOISE_RE.test(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// Benign stderr lines that never explain a nonzero exit and must not be
// surfaced as the run error: Codex always prints the YOLO approvals warning
// because this adapter passes the approvals-bypass flag itself, and
// "[paperclip] ..." lines are diagnostics the adapter injected (e.g. ACP
// fallback notes). Keep this list conservative so real errors are never
// skipped.
const BENIGN_CODEX_STDERR_LINE_RES: readonly RegExp[] = [
  /^YOLO mode is enabled\b/i,
  /^\[paperclip\]/,
];

function isBenignCodexStderrLine(line: string): boolean {
  return BENIGN_CODEX_STDERR_LINE_RES.some((re) => re.test(line));
}

export function firstMeaningfulStderrLine(text: string): string {
  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !isBenignCodexStderrLine(line));
  return meaningful ?? firstNonEmptyLine(text);
}

export function signalCodexChild(
  target: { pid: number | null; processGroupId: number | null },
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && target.processGroupId && target.processGroupId > 0) {
    try {
      process.kill(-target.processGroupId, signal);
      return true;
    } catch {
      // Fall back to direct child signal if group signaling fails (e.g. group already gone).
    }
  }
  if (target.pid && target.pid > 0) {
    try {
      process.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
