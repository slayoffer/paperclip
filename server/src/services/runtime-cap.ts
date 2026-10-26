import { readFileSync } from "node:fs";
import type { RuntimeCap } from "@paperclipai/shared";
import { getProcessRunningRunsCap } from "./instance-run-cap.js";
export type { RuntimeCap } from "@paperclipai/shared";

export function parseProcessStartTicks(stat: string): number {
  // Linux comm (field 2) can contain spaces, newlines, and closing parentheses.
  const close = stat.lastIndexOf(")");
  const raw = close < 0 ? undefined : stat.slice(close + 1).trim().split(/\s+/)[19];
  const ticks = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(ticks) || ticks < 1) {
    throw new Error("runtime_cap_process_identity_unavailable");
  }
  return ticks;
}

export function getRuntimeCap(nonce: string): RuntimeCap {
  const cap = getProcessRunningRunsCap();
  if (cap === null || !Number.isSafeInteger(cap)) {
    throw new Error("runtime_cap_unavailable");
  }
  // No estimate or platform fallback can establish the required Linux identity.
  const startTicks = parseProcessStartTicks(readFileSync("/proc/self/stat", "utf8"));
  return Object.freeze({
    schema: "paperclip.runtime-cap.v1",
    nonce,
    pid: process.pid,
    startTicks,
    cap,
    immutable: true,
  });
}
