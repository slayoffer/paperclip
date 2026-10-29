import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeManagedCloneFailure,
  ensureManagedProjectWorkspace,
  managedCloneFilterArgs,
  managedCloneTimeoutMs,
} from "../services/heartbeat.ts";

describe("managed clone timeout and filter switches", () => {
  it("keeps the 10 min default unless a sane override is set", () => {
    expect(managedCloneTimeoutMs({})).toBe(600_000);
    expect(managedCloneTimeoutMs({ PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS: "3600000" })).toBe(3_600_000);
    expect(managedCloneTimeoutMs({ PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS: "5000" })).toBe(600_000);
    expect(managedCloneTimeoutMs({ PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS: "abc" })).toBe(600_000);
    expect(managedCloneTimeoutMs({ PAPERCLIP_MANAGED_CLONE_TIMEOUT_MS: "2592000000" })).toBe(2_147_483_647);
  });

  it("accepts only known partial-clone filters", () => {
    expect(managedCloneFilterArgs({})).toEqual([]);
    expect(managedCloneFilterArgs({ PAPERCLIP_MANAGED_CLONE_FILTER: "blob:none" })).toEqual(["--filter=blob:none"]);
    expect(managedCloneFilterArgs({ PAPERCLIP_MANAGED_CLONE_FILTER: "blob:limit=1m" })).toEqual(["--filter=blob:limit=1m"]);
    expect(managedCloneFilterArgs({ PAPERCLIP_MANAGED_CLONE_FILTER: "blob:none --upload-pack=x" })).toEqual([]);
  });
});

describe("describeManagedCloneFailure", () => {
  it("names a timeout first", () => {
    const err = Object.assign(new Error("Command failed: git -c credential.helper=… clone"), {
      killed: true, signal: "SIGTERM", stderr: "Cloning into 'x'...\nremote: Enumerating objects\n",
    });
    expect(describeManagedCloneFailure(err, 600_000)).toMatch(/^git clone timed out after 10 min/);
  });

  it("puts git's own error first instead of the command line", () => {
    const err = Object.assign(new Error("Command failed: git -c credential.helper=!f() { … }; f clone"), {
      stderr: "Cloning into 'x'...\nfatal: repository 'https://example.invalid/r' not found\n",
    });
    expect(describeManagedCloneFailure(err, 600_000)).toBe("git clone failed: fatal: repository 'https://example.invalid/r' not found");
  });
});

describe("ensureManagedProjectWorkspace error text", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  beforeAll(async () => {
    originalHome = process.env.PAPERCLIP_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-clone-durability-"));
    process.env.PAPERCLIP_HOME = tempHome;
  });
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("reports the clone's real cause near the start of the message", async () => {
    const missing = path.join(tempHome, "no-such-repo");
    await expect(ensureManagedProjectWorkspace({ companyId: "c", projectId: "p", repoUrl: missing }))
      .rejects.toThrow(/Failed to prepare managed checkout .*: git clone failed: fatal: /);
  });
});
