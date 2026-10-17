import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });

  it("masks token shapes inside a long run and registered values (SYNA-1817)", () => {
    const board = `pcp_board_${"0a1b2c3d4e5f".repeat(4)}`;
    const chunk = `start ${"A".repeat(5000)}${board} opaque-registered-value-77 end`;
    const compacted = compactRunLogChunk(chunk, 1_000_000, ["opaque-registered-value-77"]);
    expect(compacted).not.toContain(board);
    expect(compacted).not.toContain("opaque-registered-value-77");
    expect(compacted.startsWith("start ")).toBe(true);
  });

  it("stays fast on a long base64-like run", () => {
    const chunk = `data ${"QUJD".repeat(60_000)} tail`;
    const started = performance.now();
    compactRunLogChunk(chunk, 1_000_000);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
