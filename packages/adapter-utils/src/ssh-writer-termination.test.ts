import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { shellQuote } from "./ssh-config.js";
import { sshWriterDirectory, sshWriterTerminationScript, trackSshWriterCommand } from "./ssh-writer-termination.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "ssh-writer-"));
  roots.push(value);
  return value;
}
async function stopped(base: string, id = "run") {
  return exec("sh", ["-c", sshWriterTerminationScript(base, id)]).then(r => r.stdout.trim() === "stopped", () => false);
}

it.skipIf(process.platform !== "linux")("requires complete evidence and keeps a surviving child session busy", async () => {
  const base = await root();
  expect(await stopped(base)).toBe(false);
  const command = trackSshWriterCommand(`exec sh -c ${shellQuote("sleep 2 </dev/null >/dev/null 2>&1 & exit 0")}`, base, "run");
  await exec("sh", ["-c", command]);
  expect(await stopped(base)).toBe(false);
  await expect.poll(() => stopped(base), { timeout: 10_000 }).toBe(true);
  const directory = sshWriterDirectory(base, "run");
  await writeFile(path.join(directory, "malformed"), "not a process identity");
  expect(await stopped(base)).toBe(false);
});

it.skipIf(process.platform !== "linux")("records separate invocations and refuses a receipt while any invocation survives", async () => {
  const base = await root();
  const child = spawn("sh", ["-c", trackSshWriterCommand("exec sleep 20", base, "run")]);
  const exited = once(child, "exit");
  try {
    await expect.poll(async () => readdir(sshWriterDirectory(base, "run")).then(x => x.length, () => 0)).toBe(1);
    await exec("sh", ["-c", trackSshWriterCommand("exec true", base, "run")]);
    expect(await readdir(sshWriterDirectory(base, "run"))).toHaveLength(2);
    expect(await stopped(base)).toBe(false);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
  await expect.poll(() => stopped(base)).toBe(true);
});

it("leaves commands without a run identity unchanged and rejects path traversal", () => {
  expect(trackSshWriterCommand("exec true", "/tmp/base")).toBe("exec true");
  expect(() => sshWriterDirectory("/tmp/base", "../another-run")).toThrow("Invalid SSH writer run id");
});

it.skipIf(process.platform !== "linux")("preserves provider exit status, including when the launcher is a process group leader", async () => {
  const base = await root();
  const script = trackSshWriterCommand("exec sh -c 'exit 23'", base, "run");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  expect((await once(child, "exit"))[0]).toBe(23);
  expect(await stopped(base)).toBe(true);
});
