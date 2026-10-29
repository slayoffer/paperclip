import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyLegacyRestartProviderState } from "./legacy-restart-provider-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe("managed restart transcripts", () => {
  it.each([["codex_local", "sessions"], ["claude_local", "projects"]])("retains %s transcripts after temporary home cleanup", async (adapter, directory) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-provider-"));
    roots.push(root);
    const source = path.join(root, "temporary");
    const saved = path.join(root, "saved");
    const next = path.join(root, "next");
    await fs.mkdir(path.join(source, directory), { recursive: true });
    await fs.writeFile(path.join(source, directory, "thread.jsonl"), "saved session");
    await fs.writeFile(path.join(source, "auth.json"), "authentication fixture");
    await copyLegacyRestartProviderState(source, saved, adapter);
    await fs.rm(source, { recursive: true });
    await copyLegacyRestartProviderState(saved, next, adapter);
    expect(await fs.readFile(path.join(next, directory, "thread.jsonl"), "utf8")).toBe("saved session");
    expect(await fs.readdir(next)).toEqual([directory]);
  });

  it("rejects missing transcripts and symbolic links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-provider-"));
    roots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.mkdir(source);
    await expect(copyLegacyRestartProviderState(source, destination, "codex_local")).rejects.toThrow("restart_provider_state_missing");
    await fs.mkdir(path.join(source, "sessions"));
    await fs.writeFile(path.join(source, "auth.json"), "authentication fixture");
    await fs.symlink(path.join(source, "auth.json"), path.join(source, "sessions", "link"));
    await expect(copyLegacyRestartProviderState(source, destination, "codex_local")).rejects.toThrow("restart_provider_state_unsafe");
  });
});
