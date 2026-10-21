import { randomUUID } from "node:crypto";
import { runLocalGit } from "./git-workspace-sync.js";
import { HostWorktreeError } from "./ssh-host-worktree-lock.js";
import { runGitWithInput } from "./ssh-host-worktree-local.js";
import { assertGitSha } from "./ssh-host-worktree-scripts.js";

export interface HostWorktreeReference {
  ref: string;
  sha: string;
  importedRef: string;
}

/** Import into temporary references and retain recovery references until completion. */
export async function importHostWorktreeReferences(input: {
  localDir: string;
  bundlePath: string;
  bundleBytes: number;
  prefix: string;
  runId: string;
  headSha: string;
  wipSha: string;
  stdout: string;
}): Promise<HostWorktreeReference[]> {
  await runLocalGit(input.localDir, ["check-ref-format", `${input.prefix}/head`]);
  const references: HostWorktreeReference[] = [];
  for (const line of input.stdout.split("\n")) {
    if (!line.startsWith("PAPERCLIP_HOST_REF\t")) continue;
    const [, sha = "", ref = ""] = line.split("\t");
    assertGitSha("manifest sha", sha);
    if (!/^refs\/(heads|tags|remotes)\//.test(ref)) throw new Error("Invalid host reference namespace");
    await runLocalGit(input.localDir, ["check-ref-format", ref]);
    references.push({ ref, sha, importedRef: `${input.prefix}/references/${ref.slice(5)}` });
  }
  const desired = [
    { ref: `refs/paperclip/export/${input.runId}`, sha: input.headSha, importedRef: `${input.prefix}/head` },
    ...(input.wipSha ? [{ ref: `refs/paperclip/wip/${input.runId}`, sha: input.wipSha, importedRef: `${input.prefix}/wip` }] : []),
    ...references,
  ];
  const temporaryPrefix = `refs/paperclip/host-import/${randomUUID()}`;
  if (input.bundleBytes > 0) {
    const advertised = (await runLocalGit(input.localDir, ["bundle", "list-heads", input.bundlePath])).stdout;
    const names = new Map(advertised.trim().split("\n").map((line) => {
      const [sha = "", ref = ""] = line.split(" ");
      return [ref, sha];
    }));
    // Excluded prerequisites need no fetch. Their objects already exist locally.
    const refspecs = desired.filter(({ ref, sha }) => names.get(ref) === sha)
      .map(({ ref }, index) => `+${ref}:${temporaryPrefix}/incoming/${index}`);
    if (refspecs.length > 0) {
      await runLocalGit(input.localDir, ["fetch", "--no-tags", "--force", input.bundlePath, ...refspecs], { timeout: 10 * 60_000 });
    }
  }
  for (const entry of desired) {
    const object = references.includes(entry) ? entry.sha : `${entry.sha}^{commit}`;
    const exists = await runLocalGit(input.localDir, ["cat-file", "-e", object]).then(() => true, () => false);
    if (!exists) throw new HostWorktreeError("host_export_incomplete", `Local checkout lacks exported object ${entry.sha}.`, [entry.sha]);
  }
  const existing = (await runLocalGit(input.localDir, ["for-each-ref", "--format=%(objectname) %(refname)", `${input.prefix}/`])).stdout
    .split("\n").filter(Boolean).map((line) => {
      const [sha, ref] = line.split(" ");
      return { sha, ref };
    });
  // A separate transaction must remove obsolete ancestor/descendant names.
  // Keep both manifests reachable if deletion or installation fails midway.
  const recovery = [
    ...existing.map(({ ref, sha }) => `update ${temporaryPrefix}/previous/${ref.slice(input.prefix.length + 1)} ${sha}`),
    ...desired.map(({ importedRef, sha }) => `update ${temporaryPrefix}/desired/${importedRef.slice(input.prefix.length + 1)} ${sha}`),
  ];
  await runGitWithInput(input.localDir, ["update-ref", "--stdin"], `${recovery.join("\n")}\n`);
  const targets = new Set(desired.map(({ importedRef }) => importedRef));
  const obsolete = existing.filter(({ ref }) => !targets.has(ref));
  if (obsolete.length > 0) {
    await runGitWithInput(input.localDir, ["update-ref", "--stdin"], `${obsolete.map(({ ref, sha }) => `delete ${ref} ${sha}`).join("\n")}\n`);
  }
  const updates = desired.map(({ importedRef, sha }) => `update ${importedRef} ${sha}`);
  await runGitWithInput(input.localDir, ["update-ref", "--stdin"], `${updates.join("\n")}\n`);
  const temporaryRefs = (await runLocalGit(input.localDir, ["for-each-ref", "--format=%(refname)", `${temporaryPrefix}/`])).stdout;
  await runGitWithInput(input.localDir, ["update-ref", "--stdin"], `${temporaryRefs.split("\n").filter(Boolean).map((ref) => `delete ${ref}`).join("\n")}\n`);
  return references;
}
