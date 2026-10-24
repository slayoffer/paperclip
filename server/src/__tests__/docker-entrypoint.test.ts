import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Behavioral tests for scripts/docker-entrypoint.sh privilege handling.
 *
 * The entrypoint must support two deployment shapes with one image:
 *  - Docker Compose: container starts as root, remaps the node user to
 *    USER_UID/USER_GID and drops privileges via gosu.
 *  - Kubernetes restricted PodSecurity / OpenShift arbitrary UIDs: the
 *    container starts non-root, where neither the remap nor gosu can work,
 *    so the command must be exec'd directly (with a warning on mismatch).
 *
 * The system commands (id, usermod, groupmod, chown, gosu) are stubbed via
 * PATH so the branching logic runs unmodified on any host.
 */

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "docker-entrypoint.sh");

let stubDir: string;
let logFile: string;

function writeStub(name: string, body: string) {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function installStubs(ids: { uid: number; gid: number; nodeUid?: number; nodeGid?: number; homeMismatch?: boolean }) {
  writeStub(
    "id",
    [
      `if [ "$1" = "-u" ] && [ "$2" = "node" ]; then echo ${ids.nodeUid ?? 1000};`,
      `elif [ "$1" = "-g" ] && [ "$2" = "node" ]; then echo ${ids.nodeGid ?? 1000};`,
      `elif [ "$1" = "-u" ]; then echo ${ids.uid};`,
      `elif [ "$1" = "-g" ]; then echo ${ids.gid};`,
      `else echo 0; fi`,
    ].join("\n"),
  );
  for (const cmd of ["usermod", "groupmod", "chown"]) {
    writeStub(cmd, `echo "${cmd} $*" >> "${logFile}"`);
  }
  // An empty probe result models correct ownership within the bounded scan.
  // A path models a UID or GID mismatch within the same scan.
  writeStub("find", ids.homeMismatch ? `echo "$1/mismatched-entry"` : `true`);
  writeStub("gosu", `echo "gosu $*" >> "${logFile}"\nshift\nexec "$@"`);
}

async function runEntrypoint(
  env: Record<string, string> = {},
  command = ["echo", "ENTRYPOINT-CMD-RAN"],
) {
  const result = await execFileAsync("sh", [ENTRYPOINT, ...command], {
    timeout: 60_000,
    env: { PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { stdout: result.stdout, stderr: result.stderr, calls };
}

beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "entrypoint-stubs-"));
  logFile = join(stubDir, "calls.log");
});

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("docker-entrypoint.sh", () => {
  it.each(["USER_UID", "USER_GID"])(
    "repairs deep ownership after an identity change even when the shallow probe matches: %j",
    async (identity) => {
      installStubs({ uid: 0, gid: 0, homeMismatch: false });
      const { calls } = await runEntrypoint({ [identity]: "1001", PAPERCLIP_HOME: stubDir });
      expect(calls).toContain(`chown -R node:node ${stubDir}`);
      expect(calls.indexOf("chown")).toBeLessThan(calls.indexOf("gosu"));
    },
  );

  it("supports explicit deep ownership repair after a restore", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: false });
    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir, PAPERCLIP_REPAIR_OWNERSHIP: "1" });
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("stops before the command when recursive ownership repair fails", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });
    writeStub("chown", "exit 77");
    await expect(runEntrypoint({ PAPERCLIP_HOME: stubDir })).rejects.toMatchObject({ code: 77 });
    expect(existsSync(logFile)).toBe(false);
  });

  it("starts a health fixture within 60 seconds without visiting deep volume contents", async () => {
    installStubs({ uid: 0, gid: 0 });
    const home = join(stubDir, "volume with spaces");
    const shallow = join(home, "instances", "default");
    const deep = join(shallow, "workspaces", "agent", "runs");
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 2_000; i++) writeFileSync(join(deep, `run-${i}`), "");
    const visits = join(stubDir, "visited.txt");
    const realFind = execFileSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).trim();
    const probe = join(stubDir, "probe.mjs");
    writeFileSync(probe, `
      import { spawnSync } from "node:child_process";
      const args = process.argv.slice(2);
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "node") args[i] = String(args[i - 1] === "-user" ? process.getuid() : process.getgid());
      }
      args.splice(args.indexOf("("), 0, "-fprint", ${JSON.stringify(visits)});
      const result = spawnSync(${JSON.stringify(realFind)}, args, { stdio: "inherit" });
      process.exit(result.status ?? 1);
    `);
    writeStub("find", `exec "${process.execPath}" "${probe}" "$@"`);
    const start = performance.now();
    const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: home }, [
      process.execPath, "-e", `
        const http = require("node:http");
        const server = http.createServer((req, res) => { res.end("ok"); });
        server.listen(0, "127.0.0.1", async () => {
          const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/health");
          console.log("HEALTH " + response.status);
          server.close();
        });
      `,
    ]);
    expect(stdout).toContain("HEALTH 200");
    const elapsedMs = performance.now() - start;
    console.info(`Entrypoint health fixture: HTTP 200 after ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeLessThan(60_000);
    expect(calls).not.toContain("chown");
    expect(readFileSync(visits, "utf8").trim().split("\n").sort()).toEqual([home, join(home, "instances"), shallow].sort());
  });

  it("keeps the root-start gosu flow with default UID/GID (Docker Compose)", async () => {
    installStubs({ uid: 0, gid: 0 });

    const { stdout, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
    expect(calls).not.toContain("usermod");
    expect(calls).not.toContain("chown");
  });

  it("remaps the node user and chowns /paperclip before gosu when root requests a different UID/GID", async () => {
    // The stubbed node uid stays 1000 while the stat probe reports the old
    // ownership, modelling the post-remap mismatch that must trigger chown.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it.each([false, true])("skips remapping a cloud identity while preserving volume repair (mismatch: %s)", async (homeMismatch) => {
    installStubs({ uid: 0, gid: 0, nodeUid: 1001, nodeGid: 1001, homeMismatch });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).not.toContain("usermod");
    expect(calls).not.toContain("groupmod");
    expect(calls.includes(`chown -R node:node ${stubDir}`)).toBe(homeMismatch);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("chowns a root-owned home before gosu even with the default UID/GID (fresh volume mount)", async () => {
    // A freshly mounted volume arrives root-owned and shadows the image's
    // build-time chown; with no remap requested the old entrypoint dropped
    // privileges onto an unwritable home and the server crashed on its
    // first mkdir.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).not.toContain("usermod");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("repairs ownership on a GID-only remap (stale group on persisted descendants)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("keeps a fully node-owned tree chown-free (no per-boot recursive chown)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: false });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).not.toContain("chown");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("honours PAPERCLIP_HOME for the ownership probe", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("execs directly and silently when already running as the requested user (restricted PodSecurity)", async () => {
    installStubs({ uid: 1000, gid: 1000 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toBe("");
    expect(calls).toBe("");
  });

  it("execs directly with a warning for an arbitrary non-root UID (OpenShift-style)", async () => {
    installStubs({ uid: 1234, gid: 1234 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1234:1234; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });

  it("execs directly with a warning on a non-root GID mismatch", async () => {
    installStubs({ uid: 1000, gid: 1001 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1000:1001; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });
});
