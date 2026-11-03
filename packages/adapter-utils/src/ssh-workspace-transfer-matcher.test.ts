import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh-sync.js";
import { needsWorkspacePathFile } from "./ssh-workspace-path-lists.js";

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["upload", "restore"])("keeps root scopes and literal patterns in large %s tar lists", async direction => {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-transfer-matcher-"));
  const source = path.join(root, "source"), target = path.join(root, "target"), bin = path.join(root, "bin");
  await Promise.all([source, target, bin].map(directory => mkdir(directory)));
  // Run the production SSH commands locally; the walker, tar and merge remain real.
  await writeFile(path.join(bin, "ssh"), '#!/usr/bin/env bash\nexec sh -c "${!#}"\n');
  await chmod(path.join(bin, "ssh"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const excluded = ["foo/bar", "literal*", "literal[ab]?", "odd '[*]?\\\n"];
  const exclude = [...excluded, "*/scoped", ...Array.from({ length: 600 }, (_, index) => `absent-${index}-${"x".repeat(64)}`)];
  expect(needsWorkspacePathFile(exclude)).toBe(true);
  const included = ["nested/foo/bar/data", "literal-other/data", "literalaZ/data", "ordinary\nfile", "nested/scoped-sibling/data"];
  const filtered = [...excluded.map(directory => `${directory}/data`), "scoped/data", "nested/scoped/data"];
  for (const relative of [...included, ...filtered, "._metadata", "nested/._metadata", "._directory/data"]) {
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await writeFile(path.join(source, relative), "incoming");
  }
  await symlink("literal-other/data", path.join(source, "link"));
  if (direction === "restore") {
    for (const relative of [...included, ...filtered]) {
      await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
      await writeFile(path.join(target, relative), "local");
    }
  }
  const spec = { host: "fixture", username: "fixture", port: 22, remoteWorkspacePath: root,
    remoteCwd: source, privateKey: null, knownHosts: null, strictHostKeyChecking: false };
  if (direction === "upload") {
    await syncDirectoryToSsh({ spec, localDir: source, remoteDir: target, exclude });
  } else {
    await syncDirectoryFromSsh({ spec, remoteDir: source, localDir: target, exclude });
  }
  for (const relative of included) expect(await readFile(path.join(target, relative), "utf8")).toBe("incoming");
  for (const relative of filtered) {
    if (direction === "restore") expect(await readFile(path.join(target, relative), "utf8")).toBe("local");
    else await expect(stat(path.join(target, relative))).rejects.toMatchObject({ code: "ENOENT" });
  }
  for (const relative of ["._metadata", "nested/._metadata", "._directory"]) {
    await expect(stat(path.join(target, relative))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readlink(path.join(target, "link"))).toBe("literal-other/data");
});
