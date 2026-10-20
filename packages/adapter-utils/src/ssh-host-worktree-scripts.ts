import path from "node:path";
import { GIT_SYNC_COMMIT_IDENTITY_ARGS } from "./git-workspace-sync.js";
import { shellQuote } from "./ssh-config.js";

// Shell builders for persistent per-host git worktrees (SYNA-2273).
// Every dynamic value goes through shellQuote, and every identifier is
// validated before it reaches a builder. The scripts print one marker line
// on stdout (PAPERCLIP_HOST_*), so the TypeScript side never parses free text.

export const HOST_WORKTREE_ROOT_DIR = ".paperclip-host";
export const HOST_WORKTREE_MARKER_ERROR = "PAPERCLIP_HOST_ERROR";
export const HOST_WORKTREE_MARKER_LOCK = "PAPERCLIP_HOST_LOCK";
export const HOST_WORKTREE_MARKER_MATERIALIZE = "PAPERCLIP_HOST_MATERIALIZE";
export const HOST_WORKTREE_MARKER_EXPORT = "PAPERCLIP_HOST_EXPORT";
export const HOST_WORKTREE_MARKER_INSPECT = "PAPERCLIP_HOST_INSPECT";
export const HOST_WORKTREE_MARKER_REMOVE = "PAPERCLIP_HOST_REMOVE";
export const HOST_WORKTREE_DEFAULT_WIP_MAX_BYTES = 50 * 1024 * 1024;

/** WIP snapshots never include dependency folders or nested agent clones. */
export const HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS = [
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob).worktrees/**",
  ":(exclude,glob).paperclip-runtime/**",
] as const;

export interface HostWorktreeLayout {
  basePath: string;
  root: string;
  reposDir: string;
  worktreesDir: string;
  locksDir: string;
  stateDir: string;
  runsDir: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,159}$/;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._\/+-]{0,199}$/;

function assertPattern(kind: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value) || value.includes("..")) {
    throw new Error(`Invalid host worktree ${kind}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertHostWorktreeId(kind: string, value: string): string {
  return assertPattern(kind, value, ID_PATTERN);
}

export function assertHostWorktreeName(value: string): string {
  return assertPattern("worktree name", value, WORKTREE_NAME_PATTERN);
}

export function assertGitSha(kind: string, value: string): string {
  return assertPattern(kind, value, SHA_PATTERN);
}

export function assertHostBranchName(value: string): string {
  assertPattern("branch", value, BRANCH_PATTERN);
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock") || value.includes("//")
    || value.split("/").some((part) => part.length === 0 || part.startsWith("."))) {
    throw new Error(`Invalid host worktree branch: ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveHostWorktreeLayout(remoteBasePath: string): HostWorktreeLayout {
  const basePath = remoteBasePath.trim();
  if (!basePath.startsWith("/")) {
    throw new Error(`Host worktree base path must be absolute: ${JSON.stringify(remoteBasePath)}`);
  }
  const root = path.posix.join(basePath, HOST_WORKTREE_ROOT_DIR);
  return {
    basePath,
    root,
    reposDir: path.posix.join(root, "repos"),
    worktreesDir: path.posix.join(root, "worktrees"),
    locksDir: path.posix.join(root, "locks"),
    stateDir: path.posix.join(root, "state"),
    runsDir: path.posix.join(root, "runs"),
  };
}

export function hostBareRepoPath(layout: HostWorktreeLayout, repoKey: string): string {
  return path.posix.join(layout.reposDir, `${assertHostWorktreeId("repo key", repoKey)}.git`);
}

export function hostWorktreePath(layout: HostWorktreeLayout, repoKey: string, worktreeName: string): string {
  return path.posix.join(layout.worktreesDir, assertHostWorktreeId("repo key", repoKey), assertHostWorktreeName(worktreeName));
}

/**
 * Name of the sibling worktree a second concurrent run gets: `<name>@<runId8>`.
 * Materialize a sibling with `branch: null`: Git refuses to check out a branch
 * that the primary worktree holds.
 */
export function hostSiblingWorktreeName(worktreeName: string, runId: string): string {
  return assertHostWorktreeName(`${assertHostWorktreeName(worktreeName)}@${assertHostWorktreeId("run id", runId).slice(0, 8)}`);
}

export function hostLockDir(layout: HostWorktreeLayout, ewId: string): string {
  return path.posix.join(layout.locksDir, assertHostWorktreeId("execution workspace id", ewId));
}

export function hostStatePath(layout: HostWorktreeLayout, ewId: string): string {
  return path.posix.join(layout.stateDir, `${assertHostWorktreeId("execution workspace id", ewId)}.json`);
}

export function hostRunDir(layout: HostWorktreeLayout, runId: string, adapterKey?: string): string {
  const runDir = path.posix.join(layout.runsDir, assertHostWorktreeId("run id", runId));
  return adapterKey ? path.posix.join(runDir, assertHostWorktreeId("adapter key", adapterKey)) : runDir;
}

const q = shellQuote;
const identity = GIT_SYNC_COMMIT_IDENTITY_ARGS.map((arg) => q(arg)).join(" ");
const wipExcludes = HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS.map((spec) => q(spec)).join(" ");

function errorLine(code: string, detailExpr = "''"): string {
  return `printf '${HOST_WORKTREE_MARKER_ERROR}\\t%s\\t%s\\n' ${q(code)} ${detailExpr}`;
}

/** `mkdir` lock: macOS has no flock(1). Prints `acquired` or `held <ageSeconds> <owner.json>`. */
export function buildHostLockAcquireScript(input: { layout: HostWorktreeLayout; lockDir: string; ownerJson: string }): string {
  const lock = q(input.lockDir);
  return [
    "set -e",
    `mkdir -p ${q(input.layout.locksDir)}`,
    `if mkdir ${lock} 2>/dev/null; then`,
    `  printf '%s' ${q(input.ownerJson)} > ${q(`${input.lockDir}/owner.json.tmp`)}`,
    `  mv -f ${q(`${input.lockDir}/owner.json.tmp`)} ${q(`${input.lockDir}/owner.json`)}`,
    `  printf '${HOST_WORKTREE_MARKER_LOCK}\\tacquired\\n'`,
    "else",
    `  owner=$(cat ${q(`${input.lockDir}/owner.json`)} 2>/dev/null || true)`,
    "  now=$(date +%s)",
    `  mtime=$(stat -c %Y ${lock} 2>/dev/null || stat -f %m ${lock} 2>/dev/null || echo "$now")`,
    `  printf '${HOST_WORKTREE_MARKER_LOCK}\\theld\\t%s\\t%s\\n' "$((now - mtime))" "$owner"`,
    "fi",
  ].join("\n");
}

/**
 * Compare-and-remove. Removes the lock only while owner.json still holds
 * `expectedOwnerJson` (empty = no owner file, then only past `minAgeSeconds`).
 */
export function buildHostLockReleaseScript(input: { lockDir: string; expectedOwnerJson: string; minAgeSeconds?: number }): string {
  const lock = q(input.lockDir);
  const minAge = Math.max(0, Math.trunc(input.minAgeSeconds ?? 0));
  return [
    "set -e",
    `if [ ! -d ${lock} ]; then printf '${HOST_WORKTREE_MARKER_LOCK}\\tabsent\\n'; exit 0; fi`,
    `current=$(cat ${q(`${input.lockDir}/owner.json`)} 2>/dev/null || true)`,
    "now=$(date +%s)",
    `mtime=$(stat -c %Y ${lock} 2>/dev/null || stat -f %m ${lock} 2>/dev/null || echo "$now")`,
    `if [ "$current" = ${q(input.expectedOwnerJson)} ] && [ "$((now - mtime))" -ge ${minAge} ]; then`,
    `  trash=${q(`${input.lockDir}.released`)}.$$`,
    `  mv ${lock} "$trash" && rm -rf "$trash"`,
    `  printf '${HOST_WORKTREE_MARKER_LOCK}\\treleased\\n'`,
    "else",
    `  printf '${HOST_WORKTREE_MARKER_LOCK}\\tnot_owner\\n'`,
    "fi",
  ].join("\n");
}

/** One SSH call: the commits the host bare repo already holds. */
export function buildHostInventoryScript(input: { bareRepo: string }): string {
  const bare = q(input.bareRepo);
  return [
    `if [ -f ${q(`${input.bareRepo}/HEAD`)} ]; then`,
    "  printf 'bare\\n'",
    `  git -C ${bare} for-each-ref --format='%(objectname)' refs/paperclip/known/`,
    "fi",
  ].join("\n");
}

export function buildHostMaterializeScript(input: {
  layout: HostWorktreeLayout;
  bareRepo: string;
  worktreePath: string;
  headSha: string;
  wipSha: string | null;
  branch: string | null;
  bundleHeadRef: string;
  bundleWipRef: string | null;
  allowDirtyReset: boolean;
}): string {
  const bare = q(input.bareRepo);
  const wt = q(input.worktreePath);
  const head = q(input.headSha);
  const shas = [input.headSha, ...(input.wipSha ? [input.wipSha] : [])];
  const refspecs = [
    q(`+${input.bundleHeadRef}:refs/paperclip/known/${input.headSha}`),
    ...(input.wipSha && input.bundleWipRef ? [q(`+${input.bundleWipRef}:refs/paperclip/known/${input.wipSha}`)] : []),
  ].join(" ");
  const checkout = input.branch
    ? `git -C ${wt} checkout -q --force --ignore-other-worktrees -B ${q(input.branch)} ${head}`
    : `git -C ${wt} -c advice.detachedHead=false checkout -q --force --detach ${head}`;
  const add = input.branch
    ? `git -C ${bare} worktree add -q --force -B ${q(input.branch)} ${wt} ${head}`
    : `git -C ${bare} worktree add -q --force --detach ${wt} ${head}`;
  return [
    "set -e",
    `mkdir -p ${q(input.layout.reposDir)} ${q(path.posix.dirname(input.worktreePath))}`,
    `if [ ! -f ${q(`${input.bareRepo}/HEAD`)} ]; then git init -q --bare ${bare}; fi`,
    `mkdir -p ${q(`${input.bareRepo}/info`)}`,
    `grep -qxF '.paperclip-runtime/' ${q(`${input.bareRepo}/info/exclude`)} 2>/dev/null || printf '%s\\n' '.paperclip-runtime/' >> ${q(`${input.bareRepo}/info/exclude`)}`,
    `tmp_bundle=$(mktemp ${q(`${input.bareRepo}/paperclip-incoming-XXXXXX`)})`,
    `trap 'rm -f "$tmp_bundle"' EXIT`,
    'cat > "$tmp_bundle"',
    `if [ -s "$tmp_bundle" ]; then git -C ${bare} fetch -q --force "$tmp_bundle" ${refspecs}; fi`,
    ...shas.flatMap((sha) => [
      `if ! git -C ${bare} cat-file -e ${q(`${sha}^{commit}`)} 2>/dev/null; then ${errorLine("host_missing_objects", q(sha))}; exit 0; fi`,
      `git -C ${bare} update-ref ${q(`refs/paperclip/known/${sha}`)} ${q(sha)}`,
    ]),
    `git -C ${bare} worktree prune`,
    `if [ -e ${q(`${input.worktreePath}/.git`)} ]; then`,
    `  if [ -n "$(git -C ${wt} status --porcelain=v1 --untracked-files=normal)" ] && [ ${input.allowDirtyReset ? "1" : "0"} != 1 ]; then`,
    `    ${errorLine("host_worktree_dirty", `"$(git -C ${wt} rev-parse HEAD)"`)}; exit 0`,
    "  fi",
    `  ${checkout}`,
    // No -x: ignored files (node_modules, build caches) must survive.
    `  git -C ${wt} clean -fdq`,
    "  action=moved",
    `elif [ -e ${wt} ] && [ -n "$(ls -A ${wt} 2>/dev/null)" ]; then`,
    `  ${errorLine("host_worktree_path_conflict", wt)}; exit 0`,
    "else",
    `  ${add}`,
    "  action=created",
    "fi",
    ...(input.wipSha
      ? [
        // Working tree = WIP, index = HEAD.
        `git -C ${wt} read-tree -u --reset ${q(`${input.wipSha}^{tree}`)}`,
        `git -C ${wt} reset -q ${head}`,
      ]
      : []),
    `printf '${HOST_WORKTREE_MARKER_MATERIALIZE}\\t%s\\t%s\\n' "$(git -C ${wt} rev-parse HEAD)" "$action"`,
  ].join("\n");
}

/**
 * Snapshot WIP with a temporary index (the real index and branch stay
 * untouched), cap its size, and write a delta bundle of HEAD + WIP
 * `--not <start head>` into `<runDir>/export.bundle`.
 */
export function buildHostExportPrepareScript(input: {
  worktreePath: string;
  runDir: string;
  runId: string;
  startHeadSha: string | null;
  wipMaxBytes: number;
  forceFullBundle: boolean;
}): string {
  const wt = q(input.worktreePath);
  const runDir = q(input.runDir);
  const wipRef = q(`refs/paperclip/wip/${input.runId}`);
  const exportRef = q(`refs/paperclip/export/${input.runId}`);
  const bundle = q(`${input.runDir}/export.bundle`);
  const idx = q(`${input.runDir}/wip.index`);
  const sizes = q(`${input.runDir}/wip.sizes`);
  const cap = Math.max(0, Math.trunc(input.wipMaxBytes));
  const start = input.startHeadSha ? q(input.startHeadSha) : null;
  return [
    "set -e",
    `if [ ! -e ${q(`${input.worktreePath}/.git`)} ]; then ${errorLine("host_worktree_missing", wt)}; exit 0; fi`,
    `mkdir -p ${runDir}`,
    `idx=${idx}`,
    `sizes=${sizes}`,
    `rm -f "$idx" "$sizes" ${bundle}`,
    `trap 'rm -f "$idx" "$sizes"' EXIT`,
    `head=$(git -C ${wt} rev-parse --verify HEAD)`,
    `real_index=$(git -C ${wt} rev-parse --git-path index)`,
    `case "$real_index" in /*) ;; *) real_index=${wt}/"$real_index" ;; esac`,
    `if [ -f "$real_index" ]; then cp "$real_index" ${idx}; fi`,
    `GIT_INDEX_FILE=${idx} git -C ${wt} add -A -- . ${wipExcludes}`,
    `tree=$(GIT_INDEX_FILE=${idx} git -C ${wt} write-tree)`,
    `head_tree=$(git -C ${wt} rev-parse "$head^{tree}")`,
    `git -C ${wt} update-ref -d ${wipRef} >/dev/null 2>&1 || true`,
    'wip=""',
    'if [ "$tree" != "$head_tree" ]; then',
    `  git -C ${wt} diff-tree -r --no-renames "$head_tree" "$tree" | awk -F '\\t' '{ split($1, m, " "); if (m[5] != "D" && m[2] != "160000") print m[4] " " $2 }' | git -C ${wt} cat-file --batch-check='%(objectsize) %(rest)' > ${sizes}`,
    `  if awk -v cap=${cap} '{ s += $1 } END { exit !(s > cap) }' ${sizes}; then`,
    `    total=$(awk '{ s += $1 } END { printf "%.0f", s }' ${sizes})`,
    `    printf '${HOST_WORKTREE_MARKER_ERROR}\\twip_too_large\\t%s' "$total"`,
    `    sort -rn ${sizes} | head -n 10 | while IFS= read -r line; do printf '\\t%s' "$line"; done`,
    "    printf '\\n'",
    "    exit 0",
    "  fi",
    `  wip=$(git -C ${wt} ${identity} commit-tree "$tree" -p "$head" -m ${q(`Paperclip host WIP snapshot ${input.runId}`)})`,
    `  git -C ${wt} update-ref ${wipRef} "$wip"`,
    "fi",
    `branch=$(git -C ${wt} symbolic-ref -q --short HEAD || true)`,
    `git -C ${wt} update-ref ${exportRef} "$head"`,
    `refs=${exportRef}`,
    `if [ -n "$wip" ]; then refs="$refs ${`refs/paperclip/wip/${input.runId}`}"; fi`,
    'base=""',
    ...(start && !input.forceFullBundle
      ? [`if git -C ${wt} cat-file -e ${q(`${input.startHeadSha}^{commit}`)} 2>/dev/null; then base=$(git -C ${wt} merge-base ${start} "$head" 2>/dev/null || true); fi`]
      : []),
    'if [ -n "$base" ]; then',
    `  count=$(git -C ${wt} rev-list --count $refs --not "$base")`,
    "else",
    `  count=$(git -C ${wt} rev-list --count $refs)`,
    "fi",
    'if [ "$count" -gt 0 ]; then',
    `  if [ -n "$base" ]; then git -C ${wt} bundle create ${bundle} $refs --not "$base" >/dev/null 2>&1; else git -C ${wt} bundle create ${bundle} $refs >/dev/null 2>&1; fi`,
    "else",
    `  : > ${bundle}`,
    "fi",
    `git -C ${wt} update-ref -d ${exportRef} >/dev/null 2>&1 || true`,
    `git -C ${wt} update-ref "refs/paperclip/known/$head" "$head"`,
    `if [ -n "$wip" ]; then git -C ${wt} update-ref "refs/paperclip/known/$wip" "$wip"; fi`,
    `size=$(wc -c < ${bundle} | tr -d ' ')`,
    `printf '${HOST_WORKTREE_MARKER_EXPORT}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$head" "$wip" "$([ -n "$wip" ] && echo 1 || echo 0)" "$size" "$branch"`,
  ].join("\n");
}

/** Streams the prepared bundle on stdout and deletes it. */
export function buildHostExportStreamScript(input: { runDir: string }): string {
  const bundle = q(`${input.runDir}/export.bundle`);
  return [`if [ -f ${bundle} ]; then cat ${bundle}; fi`, `rm -f ${bundle}`].join("\n");
}

export function buildHostInspectScript(input: { worktreePath: string }): string {
  const wt = q(input.worktreePath);
  return [
    "set -e",
    `if [ ! -e ${q(`${input.worktreePath}/.git`)} ]; then printf '${HOST_WORKTREE_MARKER_INSPECT}\\tabsent\\n'; exit 0; fi`,
    `head=$(git -C ${wt} rev-parse --verify HEAD)`,
    `branch=$(git -C ${wt} symbolic-ref -q --short HEAD || true)`,
    `if [ -n "$(git -C ${wt} status --porcelain=v1 --untracked-files=normal)" ]; then dirty=1; else dirty=0; fi`,
    `printf '${HOST_WORKTREE_MARKER_INSPECT}\\tpresent\\t%s\\t%s\\t%s\\n' "$head" "$dirty" "$branch"`,
  ].join("\n");
}

/** Removes the worktree only when its head equals `expectedHeadSha` and it is clean. */
export function buildHostRemoveScript(input: {
  bareRepo: string;
  worktreePath: string;
  statePath: string;
  expectedHeadSha: string;
}): string {
  const bare = q(input.bareRepo);
  const wt = q(input.worktreePath);
  const done = (status: string) => `printf '${HOST_WORKTREE_MARKER_REMOVE}\\t${status}\\n'`;
  return [
    "set -e",
    `if [ ! -e ${q(`${input.worktreePath}/.git`)} ]; then`,
    `  if [ -f ${q(`${input.bareRepo}/HEAD`)} ]; then git -C ${bare} worktree prune; fi`,
    `  rm -f ${q(input.statePath)}`,
    `  ${done("absent")}; exit 0`,
    "fi",
    `if [ "$(git -C ${wt} rev-parse --verify HEAD)" != ${q(input.expectedHeadSha)} ]; then ${done("head_mismatch")}; exit 0; fi`,
    `if [ -n "$(git -C ${wt} status --porcelain=v1 --untracked-files=normal)" ]; then ${done("dirty")}; exit 0; fi`,
    `git -C ${bare} worktree remove --force ${wt}`,
    `git -C ${bare} worktree prune`,
    `rm -f ${q(input.statePath)}`,
    done("removed"),
  ].join("\n");
}

export function buildHostStateWriteScript(input: { layout: HostWorktreeLayout; statePath: string; stateJson: string }): string {
  const tmp = q(`${input.statePath}.tmp`);
  return [
    "set -e",
    `mkdir -p ${q(input.layout.stateDir)}`,
    `printf '%s' ${q(input.stateJson)} > ${tmp}.$$`,
    `mv -f ${tmp}.$$ ${q(input.statePath)}`,
  ].join("\n");
}

export function buildHostStateReadScript(input: { statePath: string }): string {
  return `cat ${q(input.statePath)} 2>/dev/null || true`;
}

export function buildHostRunDirRemoveScript(input: { runDir: string }): string {
  return `rm -rf ${q(input.runDir)}`;
}
