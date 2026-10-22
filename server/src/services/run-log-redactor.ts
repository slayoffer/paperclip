import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRunLogText } from "./run-result-redaction.js";

type Stream = "stdout" | "stderr";
const MAX_PENDING_CHARS = 65_536;

/** Track discarded prefixes without retaining unbounded output. */
function createDiscardState() {
  const matches = new Map<string, { fallback: number[]; length: number }>();
  return (text: string, values: string[], resume: boolean) => {
    for (const value of values) {
      if (!value || matches.has(value)) continue;
      // Knuth-Morris-Pratt fallback lengths preserve overlapping partial matches.
      const fallback = new Array<number>(value.length).fill(0);
      for (let i = 1, length = 0; i < value.length; i++) {
        while (length > 0 && value[i] !== value[length]) length = fallback[length - 1]!;
        if (value[i] === value[length]) length++;
        fallback[i] = length;
      }
      matches.set(value, { fallback, length: 0 });
    }
    for (let i = 0; i < text.length; i++) {
      let partial = false;
      for (const [value, state] of matches) {
        while (state.length > 0 && text[i] !== value[state.length]) {
          state.length = state.fallback[state.length - 1]!;
        }
        if (text[i] === value[state.length]) state.length++;
        if (state.length === value.length) state.length = state.fallback[state.length - 1]!;
        if (state.length > 0) partial = true;
      }
      // A newline inside a partial multiline value is not a safe recovery boundary.
      if (resume && text[i] === "\n" && !partial) return i + 1;
    }
    return -1;
  };
}

/** Keep incomplete lines in memory. Never persist a fragment of a registered value. */
export function createRunLogRedactor(input: {
  values: () => Promise<string[]>;
  write: (stream: Stream, text: string) => Promise<void>;
}) {
  const pending: Record<Stream, string> = { stdout: "", stderr: "" };
  const dropping: Record<Stream, ReturnType<typeof createDiscardState> | null> = { stdout: null, stderr: null };
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
      const discard = createDiscardState();
      discard(pending[stream], values, false);
      pending[stream] = "";
      dropping[stream] = discard;
    }
  }
  return {
    append: (stream: Stream, chunk: string) => serial(async () => {
      const discard = dropping[stream];
      if (discard) {
        const resumeAt = discard(chunk, await input.values(), true);
        if (resumeAt < 0) return;
        dropping[stream] = null;
        chunk = chunk.slice(resumeAt);
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
