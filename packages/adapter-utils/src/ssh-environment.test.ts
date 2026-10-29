import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSshSpawnTarget, createSshCommandManagedRuntimeRunner, runSshCommand } from "./ssh-command.js";
import { stageSshEnvironment } from "./ssh-environment.js";
import { localSshSpec, useLocalSsh } from "./ssh-command-test-helpers.js";

const sentinel = "REVIEW_SENTINEL_NOT_A_SECRET";
const special = "quote'\nline $HOME `id` \\\nend";
let root: string;
const directories: string[] = [];
beforeEach(async () => { root = await useLocalSsh(); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function shell(command: string, stdin?: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

it("uses private files and removes them before a failing provider starts", async () => {
  const commands: string[] = [];
  const environment = await stageSshEnvironment({ PAPERCLIP_API_KEY: sentinel, CUSTOM_BINDING: special }, async (command, stdin) => {
    commands.push(command);
    const result = await shell(command, stdin);
    if (stdin) directories.push(command.match(/paperclip_env_dir='([^']+)'/)![1]);
    return result;
  });
  const directory = directories.at(-1)!;
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(`${directory}/environment`)).mode & 0o777).toBe(0o600);
  const command = environment.wrap(`test -n "$PAPERCLIP_API_KEY" && test ! -e '${directory}' && exit 23`);
  expect(commands.join("\n")).not.toContain(sentinel);
  expect(command).not.toContain(sentinel);
  await expect(shell(command)).rejects.toThrow();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await environment.cleanup();
});

it("cleans files when a target never starts", async () => {
  let directory = "";
  const environment = await stageSshEnvironment({ CUSTOM_BINDING: sentinel }, async (command, stdin) => {
    const result = await shell(command, stdin);
    if (stdin) { directory = command.match(/paperclip_env_dir='([^']+)'/)![1]; directories.push(directory); }
    return result;
  });
  await environment.cleanup();
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cleans a staged file when the upload connection fails", async () => {
  let directory = "";
  await expect(stageSshEnvironment({ CUSTOM_BINDING: sentinel }, async (command, stdin) => {
    const result = await shell(command, stdin);
    if (stdin) {
      directory = command.match(/paperclip_env_dir='([^']+)'/)![1];
      directories.push(directory);
      throw new Error("Connection closed after upload");
    }
    return result;
  })).rejects.toThrow("Connection closed after upload");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["set -x;", "set -v\n", "set -xv\n"])("disables profile tracing before reading environment values (%s)", async (profile) => {
  const environment = await stageSshEnvironment({ CUSTOM_BINDING: special, PAPERCLIP_API_KEY: sentinel }, async (command, stdin) => {
    const result = await shell(command, stdin);
    if (stdin) directories.push(command.match(/paperclip_env_dir='([^']+)'/)![1]);
    return result;
  });
  try {
    const result = await shell(`${profile}${environment.wrap('test -n "$CUSTOM_BINDING" && test -n "$PAPERCLIP_API_KEY"')}`);
    expect(result.stderr).not.toContain(sentinel);
    expect(result.stderr).not.toContain(special);
  } finally { await environment.cleanup(); }
});

it.each([0, 255])("rejects an early SSH input closure without crashing (exit %s)", async (exitCode) => {
  const calls = path.join(root, "ssh-calls");
  await writeFile(path.join(root, "bin/ssh"), `#!/bin/sh
for arg do command=$arg; done
printf '%s\\n' "$command" >> '${calls}'
case "$command" in
  *'cat >'*) exit ${exitCode} ;;
  *) exec /bin/sh -c "$command" ;;
esac
`, { mode: 0o700 });
  // A separate process proves that an unhandled stream error cannot escape the caller.
  const source = new URL("./ssh-command.ts", import.meta.url).href;
  const script = `
    const { runSshCommand } = await import(${JSON.stringify(source)});
    const env = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['BUFFER_' + i, 'x'.repeat(8192)]));
    try {
      await runSshCommand(${JSON.stringify(localSshSpec(root))}, 'true', { env });
      process.exitCode = 99;
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message }));
    }
  `;
  const loader = new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const result = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script]);
  const failure = JSON.parse(result.stdout.trim());
  expect(failure.code).toBe(exitCode === 0 ? "EPIPE" : exitCode);
  expect(failure.message).toMatch(exitCode === 0 ? /EPIPE|pipe/i : /255/);
  expect(result.stderr).not.toContain("Unhandled");
  const commands = await readFile(calls, "utf8");
  expect(commands).toContain("cat >");
  expect(commands).toContain("/bin/rm -f");
  const directory = commands.match(/paperclip_env_dir='([^']+)'/)![1];
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["in_place", "copy"])("delivers values and stdin without argv exposure in %s mode", async (mode) => {
  const cwd = mode === "copy" ? await mkdtemp(path.join(root, "copy-")) : root;
  const target = await buildSshSpawnTarget({
    spec: { ...localSshSpec(root), remoteCwd: cwd },
    command: process.execPath,
    args: ["-e", `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const parents = [];
      let pid = process.pid;
      while (pid > 1) {
        parents.push(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8'));
        pid = Number(fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^PPid:\\s+(\\d+)/m)[1]);
      }
      const ps = cp.execFileSync('ps', ['-ef'], { encoding: 'utf8' });
      const value = process.env.PAPERCLIP_API_KEY;
      console.log(JSON.stringify({ value, custom: process.env.CUSTOM_BINDING, cwd: process.cwd(),
        input: fs.readFileSync(0, 'utf8'), exposed: parents.some(p => p.includes(value)) || ps.includes(value) }));
    `],
    env: { PAPERCLIP_API_KEY: sentinel, GH_TOKEN: special, CUSTOM_BINDING: special, PAPERCLIP_RUN_ID: "sentinel-run" },
  });
  try {
    expect(target.args.join(" ")).not.toContain(sentinel);
    expect(target.args.join(" ")).not.toContain(special);
    expect(target.args.at(-1)).toContain("Paperclip SSH writer");
    const result = await shell(target.args.at(-1)!, "provider input\n");
    expect(JSON.parse(result.stdout.trim())).toEqual({ value: sentinel, custom: special, cwd, input: "provider input\n", exposed: false });
  } finally { await target.cleanup(); }
});

it("delivers environment and stdin through runSshCommand", async () => {
  const result = await runSshCommand(localSshSpec(root), 'test -n "$CUSTOM_BINDING" && cat', {
    env: { CUSTOM_BINDING: special, PAPERCLIP_API_KEY: sentinel }, stdin: "payload\n",
  });
  expect(result.stdout).toBe("payload\n");
});

it.each(["sh", "bash", process.execPath])("delivers managed runtime environment for %s", async (command) => {
  const runner = createSshCommandManagedRuntimeRunner({ spec: localSshSpec(root) });
  const args = command === process.execPath
    ? ["-e", "process.stdout.write(process.env.CUSTOM_BINDING); process.stdin.pipe(process.stdout)"]
    : ["-c", 'printf "%s" "$CUSTOM_BINDING"; cat'];
  const result = await runner.execute({ command, args, env: { CUSTOM_BINDING: special }, stdin: "input" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(special + "input");
});

it("rejects invalid keys and null bytes before upload", async () => {
  const execute = vi.fn();
  await expect(stageSshEnvironment({ "BAD KEY": sentinel }, execute)).rejects.toThrow("Invalid SSH environment variable key");
  await expect(stageSshEnvironment({ TOKEN: "a\0b" }, execute)).rejects.toThrow("Invalid SSH environment variable value");
  expect(execute).not.toHaveBeenCalled();
});
