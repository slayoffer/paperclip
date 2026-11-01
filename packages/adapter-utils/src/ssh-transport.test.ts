import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSshAuthArgs, runSshCommand } from "./ssh-command.js";
import { localSshSpec, useLocalSsh } from "./ssh-command-test-helpers.js";
import { prepareGitHubExecutionEnvironment } from "./execution-target.js";
import { isSshTransportFailure, withSshTransportRetry } from "./ssh-transport.js";

let root: string;
beforeEach(async () => { root = await useLocalSsh(); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function fakeSsh(failures: number) {
  const counter = path.join(root, "attempts");
  vi.stubEnv("SSH_TEST_COUNTER", counter);
  await writeFile(path.join(root, "bin", "ssh"), `#!/bin/sh
count=$(cat "$SSH_TEST_COUNTER" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$SSH_TEST_COUNTER"
if [ "$count" -le ${failures} ]; then
  echo 'ssh: connect to host test port 22: Connection refused' >&2
  exit 255
fi
for arg do command=$arg; done
exec /bin/sh -c "$command"
`, { mode: 0o700 });
  return async () => Number(await readFile(counter, "utf8"));
}

it("retries a transport failure and returns clean remote output", async () => {
  const attempts = await fakeSsh(1);
  expect(await runSshCommand(localSshSpec(root), "printf ready")).toEqual({ stdout: "ready", stderr: "" });
  expect(await attempts()).toBe(2);
}, 15_000);

it.each([23, 255])("does not retry remote exit %i, even with transport words", async code => {
  const attempts = await fakeSsh(0);
  await expect(runSshCommand(localSshSpec(root), `echo 'Connection reset' >&2; exit ${code}`))
    .rejects.toMatchObject({ code, stderr: "Connection reset\n" });
  expect(await attempts()).toBe(1);
});

it("stops after three transport attempts", async () => {
  const attempts = await fakeSsh(10);
  await expect(runSshCommand(localSshSpec(root), "true")).rejects.toMatchObject({ code: 255 });
  expect(await attempts()).toBe(3);
}, 15_000);

it.each([[undefined, 30], ["45", 45], ["0", 30], ["bad", 30], ["9999", 60]])(
  "uses the bounded connection timeout setting %s", async (value, expected) => {
    vi.stubEnv("PAPERCLIP_SSH_CONNECT_TIMEOUT_SEC", value);
    const auth = await createSshAuthArgs(localSshSpec(root));
    try { expect(auth.args).toContain(`ConnectTimeout=${expected}`); }
    finally { await auth.cleanup(); }
  },
);

it.each([
  { code: 255 }, { code: "ETIMEDOUT" }, { code: "ECONNRESET" }, { code: "ECONNREFUSED" },
  { stderr: "ssh: connect to host test: Connection timed out" },
  { stderr: "kex_exchange_identification: read: Connection reset by peer" },
])("classifies transport failure %j", error => {
  expect(isSshTransportFailure(error)).toBe(true);
  expect(isSshTransportFailure({ ...error, code: 23 })).toBe(false);
});

it("bounds total retry time even when individual attempts need 65 seconds", async () => {
  vi.useFakeTimers();
  vi.stubEnv("PAPERCLIP_SSH_CONNECT_TIMEOUT_SEC", "60");
  const timeouts: number[] = [];
  const retry = withSshTransportRetry(async timeout => {
    timeouts.push(timeout);
    await new Promise(resolve => setTimeout(resolve, timeout));
    throw { code: 255 };
  });
  const failed = expect(retry).rejects.toMatchObject({ name: "SshTransportError" });
  await vi.runAllTimersAsync();
  await failed;
  expect(timeouts).toEqual([65_000, 54_000]);
});

it("does not retry a timeout after the remote shell starts", async () => {
  const error = { code: "ETIMEDOUT", remoteCommandStarted: true, stderr: "kex_exchange_identification: failed" };
  const command = vi.fn(async () => { throw error; });
  await expect(withSshTransportRetry(command)).rejects.toBe(error);
  expect(command).toHaveBeenCalledOnce();
});

it("keeps the transport classification through the Git context setup probe", async () => {
  const attempts = await fakeSsh(10);
  await expect(prepareGitHubExecutionEnvironment({
    target: { kind: "remote", transport: "ssh", remoteCwd: root, spec: localSshSpec(root) },
    cwd: root, env: {}, hostCredentials: false, networkAccess: true,
  })).rejects.toMatchObject({ name: "SshTransportError" });
  expect(await attempts()).toBe(3);
}, 15_000);
