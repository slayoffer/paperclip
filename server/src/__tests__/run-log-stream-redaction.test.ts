import { describe, expect, it } from "vitest";
import { createRunLogRedactor } from "../services/run-log-redactor.js";

const opaque = "synthetic-opaque-callback-value-7V3m9";
const board = `pcp_board_${"ab".repeat(24)}`;
function fixture(values = [opaque]) {
  const lines: Array<{ stream: string; text: string }> = [];
  const writer = createRunLogRedactor({ values: async () => values, write: async (stream, text) => { lines.push({ stream, text }); } });
  return { ...writer, lines, text: () => lines.map(line => line.text).join("") };
}

describe("streamed run log masking", () => {
  for (const value of [opaque, board, `Authorization: Bearer ${opaque}`]) {
    it(`masks every split position for ${value === board ? "a board shape" : value === opaque ? "an opaque value" : "a header"}`, async () => {
      for (let i = 1; i < value.length; i++) {
        const log = fixture();
        await log.append("stdout", `neutral ${value.slice(0, i)}`);
        expect(log.text()).toBe("");
        await log.append("stdout", `${value.slice(i)} done\n`);
        await log.flush();
        expect(log.text()).not.toContain(value === board ? board : opaque);
        expect(log.text()).toContain("neutral");
        expect(log.text()).toContain("done");
      }
    });
  }
  it("serializes concurrent streams and preserves ordinary lines", async () => {
    const log = fixture();
    await Promise.all([log.append("stdout", "neutral line\n"), log.append("stderr", opaque.slice(0, 14)), log.append("stderr", opaque.slice(14))]);
    await log.flush();
    expect(log.text()).not.toContain(opaque);
    expect(log.lines.find(line => line.stream === "stdout")?.text).toBe("neutral line\n");
  });
  it("observes registration before a buffered fragment reaches storage", async () => {
    const values: string[] = [];
    const log = fixture(values);
    await log.append("stdout", opaque.slice(0, 12));
    values.push(opaque);
    await log.append("stdout", opaque.slice(12));
    await log.flush();
    expect(log.text()).not.toContain(opaque);
    expect(log.text()).toContain("REDACTED");
  });
  it("masks multi-line values across a selected line boundary", async () => {
    const value = "multi-line\nopaque-value";
    const log = fixture([value]);
    await log.append("stdout", `neutral\n${value}\n${"tail".repeat(30)}\n`);
    await log.flush();
    expect(log.text()).not.toContain(value);
    expect(log.text()).toContain("neutral");
  });
  it("keeps overlapping multi-line values intact at every chunk boundary", async () => {
    const values = ["prefix\nshared", "shared\nsuffix"];
    const text = "neutral prefix\nshared\nsuffix end\n";
    for (let i = 1; i < text.length; i++) {
      const log = fixture(values);
      await log.append("stdout", text.slice(0, i));
      await log.append("stdout", text.slice(i));
      await log.flush();
      for (const value of values) expect(log.text()).not.toContain(value);
      expect(log.text()).toContain("neutral");
    }
  });
  it("bounds an unterminated line and resumes after its newline", async () => {
    const log = fixture();
    await log.append("stdout", "x".repeat(70_000) + opaque.slice(0, 10));
    await log.append("stdout", opaque.slice(10) + "\nneutral\n");
    await log.flush();
    expect(log.text()).not.toContain(opaque.slice(10));
    expect(log.text()).toContain("oversized log line");
    expect(log.text()).toContain("neutral");
    expect(log.text().length).toBeLessThan(200);
  });
  it("refuses storage when registry resolution fails", async () => {
    let writes = 0;
    const log = createRunLogRedactor({ values: async () => { throw new Error("registry unavailable"); }, write: async () => { writes++; } });
    await expect(log.append("stdout", opaque + "\n")).rejects.toThrow("registry unavailable");
    expect(writes).toBe(0);
  });
});
