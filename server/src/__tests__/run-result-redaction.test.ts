import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactRunResultSecrets } from "../services/run-result-redaction.js";

// Synthetic, well-formed but fake credential shapes.
const GH = `gho_${"A1b2C3d4E5".repeat(4)}`;
const SK = `sk-${"abcDEF123456".repeat(2)}`;
const PAT = `github_pat_${"Ab1Cd2Ef3G".repeat(5)}`;

describe("redactRunResultSecrets", () => {
  it("masks host-side tokens inside captured stdout and nested fields", () => {
    const input = {
      stdout: `auth ok\nGITHUB_TOKEN=${GH}\nremote: https://x-access-token:${GH}@example.invalid/repo.git\n`,
      summary: "done",
      nested: { lines: [`token ${GH}`, `key ${SK}`], note: "Authorization: Bearer abcdefghijklmnop" },
      exitCode: 0,
      ok: true,
      none: null,
    };
    const out = redactRunResultSecrets(input);
    const text = JSON.stringify(out);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(SK);
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toContain(REDACTED_EVENT_VALUE);
    expect(out.summary).toBe("done");
    expect(out.exitCode).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.none).toBeNull();
    expect(Object.keys(out)).toEqual(Object.keys(input));
  });

  it("returns the same object when nothing needs redaction", () => {
    const input = { stdout: "build passed in 12s", usage: { inputTokens: 10, outputTokens: 5 }, items: ["a", "b"] };
    expect(redactRunResultSecrets(input)).toBe(input);
  });

  it("does not rebuild non-plain objects", () => {
    const when = new Date(0);
    const input = { at: when };
    expect(redactRunResultSecrets(input).at).toBe(when);
  });

  it("masks fine-grained GitHub PATs", () => {
    const out = redactRunResultSecrets({ stdout: `export GH=${PAT}` });
    expect(JSON.stringify(out)).not.toContain(PAT);
  });

  it("masks string values under credential-named keys and keeps numeric usage fields", () => {
    const out = redactRunResultSecrets({ accessToken: "opaque-host-credential-123456", usage: { inputTokens: 12 }, nextPageToken: "abcdefghijk" });
    expect(out.accessToken).toBe(REDACTED_EVENT_VALUE);
    expect(out.nextPageToken).toBe(REDACTED_EVENT_VALUE);
    expect(out.usage.inputTokens).toBe(12);
  });

  it("stays fast on long runs without whitespace and still masks tokens inside them", () => {
    const blob = "A".repeat(500_000);
    const input = { stdout: `start ${blob}${GH}${blob}.log end GITHUB_TOKEN=${GH}` };
    const started = performance.now();
    const out = redactRunResultSecrets(input);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(out.stdout).not.toContain(GH);
    expect(out.stdout.startsWith("start ")).toBe(true);
  });

  it("masks a credential assignment inside a run longer than the segment limit", () => {
    const opaque = "Zq9".repeat(366); // 1098 characters, no known token prefix
    const out = redactRunResultSecrets({ stdout: `export OPENCLAW_TOKEN=${opaque} done`, flag: `x-api-key:${opaque}` });
    expect(out.stdout).not.toContain(opaque);
    expect(out.stdout).toContain("OPENCLAW_TOKEN=");
    expect(out.flag).not.toContain(opaque);
  });

  it("keeps counts and words in a long run (neutral data)", () => {
    const run = `inputTokens:1234567890,${"a".repeat(1100)},password:required`;
    expect(redactRunResultSecrets({ stdout: run }).stdout).toBe(run);
  });

  it("still runs the shared scanner when the text contains NUL and a long run", () => {
    const blob = "B".repeat(2000);
    const input = { stdout: `a\u0000b ${blob} Authorization: Bearer abcdefghijklmnopqrstuvwx ${GH}` };
    const out = redactRunResultSecrets(input);
    expect(out.stdout).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out.stdout).not.toContain(GH);
    expect(out.stdout).toContain(blob);
    expect(out.stdout).toContain("a\u0000b");
  });

  it("masks a long bearer value through its placeholder", () => {
    const token = "Q7".repeat(700);
    const out = redactRunResultSecrets({ stdout: `curl -H "Authorization: Bearer ${token}" https://example.invalid` });
    expect(out.stdout).not.toContain(token);
  });

  it("never stores a raw subtree past the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: `token ${GH}`, count: 3 };
    for (let i = 0; i < 80; i++) deep = { next: deep };
    const out = JSON.stringify(redactRunResultSecrets(deep));
    expect(out).not.toContain(GH);
    expect(out).toContain("count");
  });

  it("keeps a neutral deep subtree's content", () => {
    let deep: Record<string, unknown> = { leaf: "plain value", n: 42 };
    for (let i = 0; i < 70; i++) deep = { next: deep };
    const out = JSON.stringify(redactRunResultSecrets(deep));
    expect(out).toContain("plain value");
  });

  it("masks Paperclip keys and Telegram bot tokens", () => {
    const board = `pcp_board_${"0a1b2c3d4e5f".repeat(4)}`;
    const agent = `pcp_${"9f8e7d6c5b4a".repeat(4)}`;
    const bot = `1234567890:AA${"Bc1De2Fg3Hi4Jk5Lm6No7Pq8Rs9Tu0Vw1"}`;
    const out = JSON.stringify(redactRunResultSecrets({ stdout: `k=${board} a ${agent} t ${bot}`, long: `x${"Y".repeat(1100)}${board}` }));
    expect(out).not.toContain(board);
    expect(out).not.toContain(agent);
    expect(out).not.toContain(bot);
  });

  it("stays linear on adversarial assignment and JWT-prefix runs (codex P1)", () => {
    for (const input of ["token=aaaa".repeat(16_000), "eyJ".repeat(53_000)]) {
      const started = performance.now();
      redactRunResultSecrets({ stdout: input });
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("masks an alphabetic password inside long minified JSON (codex P2)", () => {
    const text = JSON.stringify({ data: "A".repeat(1100), password: "correct-horse-battery" });
    expect(redactRunResultSecrets({ stdout: text }).stdout).not.toContain("correct-horse-battery");
  });

  it("redacts a string leaf exactly past the depth limit (codex P2)", () => {
    const board = `pcp_board_${"0a1b2c3d4e5f".repeat(4)}`;
    let deep: unknown = board;
    for (let i = 0; i < 65; i++) deep = { next: deep };
    expect(JSON.stringify(redactRunResultSecrets(deep))).not.toContain(board);
  });

  it("masks a short registered value (codex P2)", async () => {
    const { redactRunPersistencePatch } = await import("../services/run-result-redaction.js");
    expect(redactRunPersistencePatch({ stdoutExcerpt: "result: z9!Ab6" }, ["z9!Ab6"]).stdoutExcerpt).not.toContain("z9!Ab6");
  });

  it("re-review: partial marker, JWT after a hyphen, 1-3 character secrets, credential key at depth 65", async () => {
    const { redactRunPersistencePatch } = await import("../services/run-result-redaction.js");
    const partial = JSON.stringify({ padding: "A".repeat(1100), password: "opaque9***REDACTED***suffix" });
    expect(redactRunResultSecrets({ s: partial }).s).not.toContain("opaque9");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghABCDEFGH12345678";
    const url = JSON.stringify({ padding: "A".repeat(1100), url: `https://example.invalid/#id-${jwt}` });
    expect(redactRunResultSecrets({ s: url }).s).not.toContain("abcdefghABCDEFGH12345678");
    expect(redactRunResultSecrets({ s: `short ${jwt} text` }).s).not.toContain(jwt);
    expect(redactRunPersistencePatch({ stdoutExcerpt: "result: z9!" }, ["z9!"]).stdoutExcerpt).not.toContain("z9!");
    expect(redactRunPersistencePatch({ stdoutExcerpt: "ab1 cab1d" }, ["ab1"]).stdoutExcerpt).toContain("cab1d");
    let deep: unknown = { password: "correct-horse-battery" };
    for (let i = 0; i < 64; i++) deep = { next: deep };
    expect(JSON.stringify(redactRunResultSecrets(deep))).not.toContain("correct-horse-battery");
  });

  it("keeps an own __proto__ key as data", () => {
    const input = JSON.parse(`{"__proto__":{"x":1},"stdout":"token ${GH}"}`);
    const out = redactRunResultSecrets(input);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.stdout).not.toContain(GH);
  });
});
