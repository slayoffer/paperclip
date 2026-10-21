import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildSshSpawnTarget } from "./ssh-command.js";
import { buildSshEnvLabFixtureConfig, getSshEnvLabSupport, startSshEnvLabFixture, stopSshEnvLabFixture } from "./ssh-fixture.js";
import type { SshEnvLabFixtureState } from "./ssh-config.js";

const exec = promisify(execFile);
const managerEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}` };
const supported = process.platform === "linux" && (await getSshEnvLabSupport()).supported && await exec(
  "systemd-run", ["--user", "--scope", "--quiet", "--expand-environment=no", "true"], { env: managerEnv },
).then(() => true, () => false);
if (process.env.PAPERCLIP_REQUIRE_WRITER_CONTAINMENT_TESTS === "1" && !supported) {
  throw new Error("SSH credential tests require sshd, a systemd user manager, and cgroup v2");
}

let root: string;
let fixture: SshEnvLabFixtureState | undefined;
beforeAll(async () => {
  if (!supported) return;
  root = await mkdtemp(path.join(os.tmpdir(), "ssh-environment-integration-"));
  fixture = await startSshEnvLabFixture({ statePath: path.join(root, "state.json") });
}, 30_000);
afterAll(async () => {
  try { if (fixture) await stopSshEnvLabFixture(fixture); }
  finally { if (root) await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!supported).each([
  ["in_place", 0], ["in_place", 23], ["copy", 0], ["copy", 23],
] as const)("hides credentials during a real %s SSH launch with exit %i", async (mode, exitCode) => {
  const state = fixture!;
  const config = await buildSshEnvLabFixtureConfig(state);
  const cwd = path.join(state.workspaceDir, `${mode}-${exitCode}`);
  await mkdir(cwd);
  const output = path.join(cwd, "proof.json");
  const stop = path.join(cwd, "stop");
  const provider = path.join(cwd, "provider.cjs");
  await writeFile(provider, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const value = process.env.PAPERCLIP_API_KEY;
    const commands = [];
    for (const name of fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name))) {
      try { commands.push(fs.readFileSync('/proc/' + name + '/cmdline', 'utf8')); } catch {}
    }
    const ps = cp.execFileSync('ps', ['-ef'], { encoding: 'utf8' });
    const input = fs.readFileSync(0, 'utf8');
    fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ value, input, cwd: process.cwd(),
      custom: process.env.CUSTOM_BINDING, exposed: commands.some(c => c.includes(value)) || ps.includes(value) }));
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); process.exit(${exitCode}); }
    }, 20);
    setTimeout(() => process.exit(124), 20000).unref();
  `);
  const sentinel = "REVIEW_SENTINEL_NOT_A_SECRET";
  const target = await buildSshSpawnTarget({
    spec: { ...config, remoteCwd: cwd }, command: process.execPath, args: [provider],
    env: { PAPERCLIP_API_KEY: sentinel, GH_TOKEN: sentinel, CUSTOM_BINDING: sentinel, PAPERCLIP_RUN_ID: `${mode}-${exitCode}` },
  });
  expect(target.args.join(" ")).not.toContain(sentinel);
  const script = target.args.at(-1)!;
  const directory = script.match(/\/tmp\/paperclip-ssh-env\.[0-9a-f-]+/)![0];
  const unit = script.match(/paperclip-writer-[0-9a-f-]+\.scope/)![0];
  const child = spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"], env: managerEnv });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.resume();
  child.stdin.end("provider input\n");
  try {
    await expect.poll(() => readFile(output, "utf8").then(JSON.parse, () => null), { timeout: 10_000 }).toEqual({
      value: sentinel, custom: sentinel, input: "provider input\n", cwd, exposed: false,
    });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const properties = (await exec("systemctl", ["--user", "show", unit], { env: managerEnv })).stdout;
    expect(properties).toContain("ActiveState=active");
    expect(properties).toContain("Description=Paperclip SSH writer\n");
    expect(properties).not.toContain(sentinel);
  } finally {
    await writeFile(stop, "stop");
    expect((await exited)[0], stderr).toBe(exitCode);
    await target.cleanup();
  }
  await expect.poll(() => exec("journalctl", ["--user", "-u", unit, "--no-pager", "--output=json"], { env: managerEnv })
    .then(result => result.stdout), { timeout: 5_000 }).toContain(unit);
  const journal = (await exec("journalctl", ["--user", "-u", unit, "--no-pager", "--output=json"], { env: managerEnv })).stdout;
  expect(journal).toContain("Paperclip SSH writer");
  expect(journal).not.toContain(sentinel);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
