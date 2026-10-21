import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRunLogText } from "./run-result-redaction.js";

type Stream = "stdout" | "stderr";
const MAX_PENDING_CHARS = 65_536;

/** Keep incomplete lines in memory. Never persist a fragment of a registered value. */
export function createRunLogRedactor(input: {
  values: () => Promise<string[]>;
  write: (stream: Stream, text: string) => Promise<void>;
}) {
  const pending: Record<Stream, string> = { stdout: "", stderr: "" };
  const dropping: Record<Stream, boolean> = { stdout: false, stderr: false };
  let tail = Promise.resolve();
  function serial(work: () => Promise<void>) {
    const result = tail.then(work);
    tail = result;
    return result;
  }
  async function emit(stream: Stream, final: boolean) {
    const values = await input.values();
    const text = pending[stream];
    const reserve = values.reduce((max, value) => Math.max(max, value.length - 1), 0);
    let end = final ? text.length : text.length <= reserve ? 0 : text.lastIndexOf("\n", text.length - reserve - 1) + 1;
    // A complete multi-line value can cross the selected line boundary.
    let previousEnd: number;
    do {
      previousEnd = end;
      for (const value of values) {
        if (!value || end === 0) continue;
        const start = text.lastIndexOf(value, end - 1);
        if (start >= 0 && start < end && start + value.length > end) end = start;
      }
    } while (end !== previousEnd);
    if (end > 0) {
      await input.write(stream, redactRunLogText(text.slice(0, end), values));
      pending[stream] = text.slice(end);
    }
    if (pending[stream].length > MAX_PENDING_CHARS) {
      // An unbounded line must not retain unbounded plaintext or expose a cut token.
      await input.write(stream, `${REDACTED_EVENT_VALUE}[oversized log line]\n`);
      pending[stream] = "";
      dropping[stream] = true;
    }
  }
  return {
    append: (stream: Stream, chunk: string) => serial(async () => {
      if (dropping[stream]) {
        const newline = chunk.indexOf("\n");
        if (newline < 0) return;
        dropping[stream] = false;
        chunk = chunk.slice(newline + 1);
      }
      pending[stream] += chunk;
      await emit(stream, false);
    }),
    flush: () => serial(async () => {
      await emit("stdout", true);
      await emit("stderr", true);
    }),
  };
}
