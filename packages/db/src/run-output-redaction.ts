import { customType } from "drizzle-orm/pg-core";

/**
 * Write-time credential redaction for stored run output (SYNA-1586).
 *
 * The heartbeat_runs columns that hold process output (`result_json`, `error`,
 * `stdout_excerpt`, `stderr_excerpt`) use the column types below. Drizzle calls
 * their encoder for every `insert().values()`, every `update().set()` and every
 * `sql.param(value, column)`. So no write path can store output without the
 * redactor, also a path that does not know about redaction.
 *
 * The redaction policy lives in the server (it shares the run-log scanner), so
 * the server installs it at startup with `setRunOutputRedactor`. Without an
 * installed redactor the columns behave like plain `jsonb` and `text`.
 *
 * A raw `${JSON.stringify(value)}::jsonb` fragment is a plain parameter with no
 * column encoder. Use `sql.param(value, heartbeatRuns.resultJson)` instead.
 */
export type RunOutputRedactor = {
  json: <T>(value: T) => T;
  text: (value: string) => string;
};

let installed: RunOutputRedactor | null = null;

export function setRunOutputRedactor(redactor: RunOutputRedactor | null): void {
  installed = redactor;
}

export function getRunOutputRedactor(): RunOutputRedactor | null {
  return installed;
}

/** Same driver mapping as drizzle's `jsonb`, plus the installed redactor on write. */
export const redactedRunJson = customType<{
  data: Record<string, unknown>;
  driverData: string;
}>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(installed ? installed.json(value) : value),
  fromDriver: (value) => {
    if (typeof value !== "string") return value as Record<string, unknown>;
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return value as unknown as Record<string, unknown>;
    }
  },
});

/** Same driver mapping as drizzle's `text`, plus the installed redactor on write. */
export const redactedRunText = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: (value) => (installed && typeof value === "string" ? installed.text(value) : value),
});
