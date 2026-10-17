import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";

/**
 * Redact token-shaped text in an adapter result before it is persisted.
 *
 * Read-time redaction (run-secret-redaction) masks only the secret values that
 * Paperclip injected into the run. An agent process can also print a credential
 * that it obtained on the host (for example a CLI login token) into its
 * captured stdout, and adapters store that output in the result. Without a
 * write-time pass, such a value is stored as written and returned as written.
 *
 * This walks plain objects and arrays. Every string leaf goes through the
 * shared text scanner, and a string under a credential-named key is masked
 * whole. Keys, numbers, booleans and the object shape are kept.
 *
 * Captured output can be megabytes and can hold very long runs of non-space
 * characters (base64 blobs). The shared scanner's unanchored expressions are
 * quadratic on such runs, so a run longer than LONG_SEGMENT only gets the
 * prefix-anchored token expressions below, which stay linear.
 */
const LONG_SEGMENT = 1024;
const LONG_SEGMENT_RE = new RegExp(String.raw`\S{${LONG_SEGMENT + 1},}`, "g");
const HAS_LONG_SEGMENT_RE = new RegExp(String.raw`\S{${LONG_SEGMENT + 1}}`);
// Placeholders use a private-use character that the input does not contain (the input may contain NUL).
const SENTINEL_CANDIDATES = Array.from({ length: 64 }, (_, i) => String.fromCharCode(0xe000 + i));
const MAX_DEPTH = 64;
const DEEP_SUBTREE_MAX_CHARS = 65_536;

// Prefix-anchored credential shapes: each match attempt fails fast at a position without the literal prefix.
const LINEAR_TOKEN_RES = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // Starts only where a run of token characters starts (lookbehind), so "eyJeyJ…" without dots is scanned once.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Paperclip agent, board, CLI, claim and invite keys (server/src/services/{agents,board-auth}.ts, routes/access.ts).
  /pcp_(?:board_|cli_auth_|claim_|invite_)?[0-9a-f]{48}/g,
  // Telegram bot token: bot id, ":AA", 33 more characters.
  /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
];
// Credential-named assignment (`TOKEN=…`, `"api_key":"…"`) inside a long run, where the shared scanner does not run.
// No lookahead: an attempt either fails within the bounded key and separator, or consumes the whole value, so the scan
// stays linear. The callback keeps pure counts ("tokens: 1234567890") and a few neutral words; any other value is masked.
const LINEAR_ASSIGNMENT_RE =
  /(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)([A-Za-z0-9_-]{0,40}\\?["']?\s{0,5}[:=]\s{0,5}\\?["']?)([^\s"'\\&;,]{4,})/gi;
const NEUTRAL_ASSIGNMENT_VALUE = /^(?:[0-9]+|true|false|null|undefined|none|required|optional|redacted|\*+|\[redacted\]|\$\{[A-Za-z0-9_]+\}?)$/i;

function redactLinear(input: string): string {
  return LINEAR_TOKEN_RES.reduce((text, re) => text.replace(re, REDACTED_EVENT_VALUE), input);
}

function redactLongSegment(segment: string): string {
  return redactLinear(segment)
    .replace(LINEAR_ASSIGNMENT_RE, (match: string, key: string, separator: string, value: string) =>
      NEUTRAL_ASSIGNMENT_VALUE.test(value) || value.includes(REDACTED_EVENT_VALUE) ? match : `${key}${separator}${REDACTED_EVENT_VALUE}`);
}

function redactString(input: string): string {
  if (!HAS_LONG_SEGMENT_RE.test(input)) {
    // The shared scanner has no fine-grained PAT shape; the linear pass adds it.
    return redactLinear(redactSensitiveText(input));
  }
  const sentinel = SENTINEL_CANDIDATES.find((candidate) => !input.includes(candidate));
  const long: string[] = [];
  const masked = input.replace(LONG_SEGMENT_RE, (segment) => {
    // No free sentinel (practically impossible): mask the whole long run rather than skip the shared scanner.
    if (!sentinel) return REDACTED_EVENT_VALUE;
    long.push(redactLongSegment(segment));
    return `${sentinel}${long.length - 1}${sentinel}`;
  });
  const scanned = redactLinear(redactSensitiveText(masked));
  if (!sentinel) return scanned;
  // A placeholder that the scanner masked (for example the value after "Bearer ") stays masked.
  const placeholder = new RegExp(`${sentinel}(\\d+)${sentinel}`, "g");
  return scanned.replace(placeholder, (match, index: string) => long[Number(index)] ?? match);
}

function redactDeepSubtree(value: unknown): string {
  // Past the depth limit, store a redacted, size-capped string instead of the raw subtree.
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return REDACTED_EVENT_VALUE;
  }
  const capped = text.length > DEEP_SUBTREE_MAX_CHARS
    ? `${text.slice(0, DEEP_SUBTREE_MAX_CHARS)}[truncated ${text.length - DEEP_SUBTREE_MAX_CHARS} chars]`
    : text;
  return redactString(capped);
}

const CREDENTIAL_KEYS = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearertoken", "sessiontoken",
  "apikey", "secret", "clientsecret", "password", "passwd", "authorization", "cookie", "privatekey",
]);

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_KEYS.has(normalized) || /(?:token|secret|password|apikey)$/.test(normalized);
}

export function redactRunResultSecrets<T>(value: T, depth = 0, key: string | null = null): T {
  if (depth > MAX_DEPTH) {
    if (typeof value === "string") return redactString(value) as T;
    return (value !== null && typeof value === "object" ? redactDeepSubtree(value) : value) as T;
  }
  if (typeof value === "string") {
    if (key !== null && value.length >= 8 && isCredentialKey(key)) return REDACTED_EVENT_VALUE as T;
    return redactString(value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactRunResultSecrets(item, depth + 1, null);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as T;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [entryKey, item] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactRunResultSecrets(item, depth + 1, entryKey);
      if (redacted !== item) changed = true;
      // defineProperty keeps an own `__proto__` key as data instead of calling the prototype setter.
      Object.defineProperty(next, entryKey, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return (changed ? next : value) as T;
  }
  return value;
}

// Registered and declared values are known secrets; only trivially short ones are skipped (they would mask noise).
const MIN_REGISTERED_VALUE_LENGTH = 4;

/**
 * Bounded text policy for one run-log chunk (SYNA-1817 finding 5): the same token shapes as stored results (linear on
 * long runs), then the run's registered values. A value split across two chunks is not seen here; the excerpts are
 * scanned again whole when the run row is written.
 */
export function redactRunLogText(text: string, registeredValues: string[] = []): string {
  const shaped = redactString(text);
  const values = registeredValues.filter((value) => value.length >= MIN_REGISTERED_VALUE_LENGTH);
  return values.length > 0 ? redactRegisteredSecretValues(shaped, values) : shaped;
}

/**
 * Values of env keys that are bound to secrets (declared secret keys), for write-time masking. Only declared keys:
 * masking every env value would also mask neutral settings such as URLs and paths in stored output.
 */
export function declaredSecretValues(env: unknown, secretKeys: Iterable<string>): string[] {
  if (!env || typeof env !== "object") return [];
  const values = new Set<string>();
  for (const key of secretKeys) {
    const value = (env as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length >= MIN_REGISTERED_VALUE_LENGTH) values.add(value);
  }
  return [...values].sort((left, right) => right.length - left.length);
}

const PERSISTED_TEXT_FIELDS = ["error", "stdoutExcerpt", "stderrExcerpt", "resultJson"] as const;
type PersistedRunFields = Partial<Record<(typeof PERSISTED_TEXT_FIELDS)[number], unknown>>;

/**
 * One write-time policy for a heartbeat run row (SYNA-1817 findings 1 and 4): token shapes, then the run's registered
 * secret values, on `error`, both excerpts and `resultJson`. Other fields pass through unchanged. Idempotent.
 */
export function redactRunPersistencePatch<T extends PersistedRunFields>(patch: T, registeredValues: string[]): T {
  let changed = false;
  const next: Record<string, unknown> = { ...patch };
  const values = registeredValues.filter((value) => value.length >= MIN_REGISTERED_VALUE_LENGTH);
  for (const field of PERSISTED_TEXT_FIELDS) {
    const current = next[field];
    if (current === null || current === undefined) continue;
    let redacted = redactRunResultSecrets(current);
    if (values.length > 0) redacted = redactRegisteredSecretValues(redacted, values);
    if (redacted !== current) {
      next[field] = redacted;
      changed = true;
    }
  }
  return (changed ? next : patch) as T;
}
