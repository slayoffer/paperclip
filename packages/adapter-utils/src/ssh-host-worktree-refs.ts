import { runLocalGit } from "./git-workspace-sync.js";
import { HostWorktreeError } from "./ssh-host-worktree-lock.js";
import { runGitWithInput } from "./ssh-host-worktree-local.js";
import { assertGitSha } from "./ssh-host-worktree-scripts.js";

export interface HostWorktreeReference {
  ref: string;
  sha: string;
  importedRef: string;
}

/** Import advertised bundle references, then update the complete manifest atomically. */
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
  if (input.bundleBytes > 0) {
    const advertised = (await runLocalGit(input.localDir, ["bundle", "list-heads", input.bundlePath])).stdout;
    const names = new Map(advertised.trim().split("\n").map((line) => {
      const [sha = "", ref = ""] = line.split(" ");
      return [ref, sha];
    }));
    // Excluded prerequisites need no fetch. Their objects already exist locally.
    const refspecs = desired.filter(({ ref, sha }) => names.get(ref) === sha)
      .map(({ ref, importedRef }) => `+${ref}:${importedRef}`);
    if (refspecs.length > 0) {
      await runLocalGit(input.localDir, ["fetch", "--no-tags", "--force", input.bundlePath, ...refspecs], { timeout: 10 * 60_000 });
    }
  }
  for (const entry of desired) {
    const object = references.includes(entry) ? entry.sha : `${entry.sha}^{commit}`;
    const exists = await runLocalGit(input.localDir, ["cat-file", "-e", object]).then(() => true, () => false);
    if (!exists) throw new HostWorktreeError("host_export_incomplete", `Local checkout lacks exported object ${entry.sha}.`, [entry.sha]);
  }
  const existing = (await runLocalGit(input.localDir, ["for-each-ref", "--format=%(refname)", `${input.prefix}/references/`])).stdout;
  const targets = new Set(desired.map(({ importedRef }) => importedRef));
  const updates = desired.map(({ importedRef, sha }) => `update ${importedRef} ${sha}`);
  for (const ref of existing.split("\n").filter(Boolean)) {
    if (!targets.has(ref)) updates.push(`delete ${ref}`);
  }
  if (!input.wipSha) updates.push(`delete ${input.prefix}/wip`);
  await runGitWithInput(input.localDir, ["update-ref", "--stdin"], `${updates.join("\n")}\n`);
  return references;
}
