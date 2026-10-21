import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { shellQuote } from "./ssh-config.js";
import { sshWriterDirectory, sshWriterTerminationScript, trackSshWriterCommand } from "./ssh-writer-termination.js";

const exec = promisify(execFile);
const containmentSupported = await exec("systemd-run", ["--user", "--scope", "--quiet", "--expand-environment=no", "true"], {
  env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` },
}).then(() => true, () => false);
if (process.env.PAPERCLIP_REQUIRE_WRITER_CONTAINMENT_TESTS === "1" && !containmentSupported) {
  throw new Error("Writer containment tests require a systemd user manager and cgroup v2");
}
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

it.skipIf(!containmentSupported)("requires complete evidence and keeps a surviving child control group busy", async () => {
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

it.skipIf(!containmentSupported)("records separate invocations and refuses a receipt while any invocation survives", async () => {
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

it.skipIf(!containmentSupported)("preserves provider exit status, including when the launcher is a process group leader", async () => {
  const base = await root();
  const script = trackSshWriterCommand("exec sh -c 'exit 23'", base, "run");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  expect((await once(child, "exit"))[0]).toBe(23);
  expect(await stopped(base)).toBe(true);
});

it.skipIf(!containmentSupported)("keeps a detached Node writer busy after its launcher exits", async () => {
  const base = await root();
  const output = path.join(base, "writes");
  const stop = path.join(base, "stop");
  const source = path.join(base, "launcher.cjs");
  await writeFile(source, `const { spawn } = require('node:child_process');
    const code = "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(timer); else fs.appendFileSync(process.argv[1], 'x'); }, 20); setTimeout(() => clearInterval(timer), 30000).unref();";
    const child = spawn(process.execPath, ['-e', code, ${JSON.stringify(output)}, ${JSON.stringify(stop)}], { detached: true, stdio: 'ignore' });
    child.unref();`);
  await exec("sh", ["-c", trackSshWriterCommand(`exec ${shellQuote(process.execPath)} ${shellQuote(source)}`, base, "run")]);
  await expect.poll(() => readFile(output, "utf8").then(x => x.length, () => 0)).toBeGreaterThan(0);
  const before = (await readFile(output, "utf8")).length;
  expect(await stopped(base)).toBe(false);
  await expect.poll(async () => (await readFile(output, "utf8")).length).toBeGreaterThan(before);
  await writeFile(stop, "stop");
  await expect.poll(() => stopped(base), { timeout: 10_000 }).toBe(true);
});

it("preserves ownership when the user manager is unavailable, including across later contained invocations", async () => {
  const base = await root();
  const result = await exec("sh", ["-c", trackSshWriterCommand("printf 'fallback ran'", base, "run")], {
    env: { ...process.env, XDG_RUNTIME_DIR: path.join(base, "no-manager"), DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent" },
  });
  expect(result.stdout).toBe("fallback ran");
  expect(await stopped(base)).toBe(false);
  await exec("sh", ["-c", trackSshWriterCommand("exec true", base, "run")]);
  expect(await stopped(base)).toBe(false);
});

it.skipIf(process.platform !== "linux")("rejects old session-only records even after the session disappears", async () => {
  const base = await root();
  await exec("sh", ["-c", trackSshWriterCommand("exec true", base, "run")]);
  const directory = sshWriterDirectory(base, "run");
  const [name] = await readdir(directory);
  const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
  await writeFile(path.join(directory, name!), `${boot.trim()}\n999999999\n`);
  expect(await stopped(base)).toBe(false);
});

it.skipIf(!containmentSupported)("rejects a changed control group hierarchy and preserves literal shell arguments", async () => {
  const base = await root();
  const result = await exec("sh", ["-c", trackSshWriterCommand("printf '%s' '$PAPERCLIP_LITERAL'", base, "run")]);
  expect(result.stdout).toBe("$PAPERCLIP_LITERAL");
  expect(await stopped(base)).toBe(true);
  const directory = sshWriterDirectory(base, "run");
  const [name] = await readdir(directory);
  const marker = path.join(directory, name!);
  const record = JSON.parse(await readFile(marker, "utf8"));
  record.hierarchy = [0, 0];
  await writeFile(marker, JSON.stringify(record));
  expect(await stopped(base)).toBe(false);
});
