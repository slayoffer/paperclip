export function sshConnectTimeoutSec(): number {
  const value = Number(process.env.PAPERCLIP_SSH_CONNECT_TIMEOUT_SEC);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60) : 30;
}

export class SshTransportError extends Error {
  readonly code = 255;
  constructor(cause: unknown) {
    super("Execution-target SSH transport failed (255) after bounded retries", { cause });
    this.name = "SshTransportError";
  }
}

export function isSshTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    code?: unknown; stderr?: unknown; remoteCommandExited?: boolean; remoteCommandStarted?: boolean;
  };
  if (failure.remoteCommandExited) return false;
  // A remote command can print transport words. Its exit status takes precedence.
  if (typeof failure.code === "number") return failure.code === 255;
  if (failure.remoteCommandStarted) return false;
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(String(failure.code))) return true;
  return typeof failure.stderr === "string" &&
    /(?:ssh:.*(?:connection (?:timed out|reset|refused)|operation timed out)|(?:kex_exchange_identification|ssh_exchange_identification):)/i.test(failure.stderr);
}

export async function withSshTransportRetry<T>(
  execute: (timeoutMs: number) => Promise<T>,
  commandTimeoutMs = 15_000,
): Promise<T> {
  const attemptTimeout = Math.max(commandTimeoutMs, (sshConnectTimeoutSec() + 5) * 1000);
  const deadline = Date.now() + Math.max(attemptTimeout, 120_000);
  let lastFailure: unknown;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0 && Date.now() >= deadline) throw new SshTransportError(lastFailure);
    try {
      return await execute(Math.max(1, Math.min(attemptTimeout, deadline - Date.now())));
    } catch (error) {
      if (error instanceof SshTransportError) throw error;
      if (!isSshTransportFailure(error)) throw error;
      lastFailure = error;
      const backoff = 1000 * 2 ** attempt;
      if (attempt >= 2 || Date.now() + backoff >= deadline) throw new SshTransportError(error);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
}
