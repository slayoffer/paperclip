const MAX_BODY_EXCERPT_LENGTH = 512;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i;

export async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (response.ok) throw error;
    return "[body unavailable]";
  }
}

function redactText(text: string, secrets: readonly string[]): string {
  text = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, " ")
    .replace(/<[\s\S]*$/g, " ");
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(secret).join(REDACTED);
    text = text.split(encodeURIComponent(secret)).join(REDACTED);
  }
  return text
    .replace(/\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*:[^\r\n<>]*/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(
      /\b([a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[a-z0-9_-]*)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s<,;]+)/gi,
      `$1=${REDACTED}`,
    );
}

function redactBody(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactBody(entry, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactText(key, secrets),
      SENSITIVE_KEY.test(key) ? REDACTED : redactBody(entry, secrets, depth + 1),
    ]));
  }
  return value;
}

function bodyExcerpt(body: unknown, secrets: readonly string[]): string {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as unknown;
    } catch {
      // An HTML or plain-text error still needs an HTTP status and an excerpt.
    }
  }
  const safeBody = redactBody(body, secrets);
  const text = (typeof safeBody === "string" ? safeBody : JSON.stringify(safeBody)) ?? "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > MAX_BODY_EXCERPT_LENGTH
    ? `${compact.slice(0, MAX_BODY_EXCERPT_LENGTH - 3)}...`
    : compact;
}

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    secrets?: readonly string[];
  }) {
    const secrets = input.secrets ?? [];
    const method = input.method.toUpperCase();
    const path = redactText(input.path.split(/[?#]/, 1)[0] ?? "", secrets);
    const body = bodyExcerpt(input.body, secrets);
    super(`${method} ${path} failed with HTTP ${input.status}${body ? `: ${body}` : ""}`);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}
