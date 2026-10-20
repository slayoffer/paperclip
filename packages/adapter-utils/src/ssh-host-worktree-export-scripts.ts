import { GIT_SYNC_COMMIT_IDENTITY_ARGS } from "./git-workspace-sync.js";
import { shellQuote } from "./ssh-config.js";
import { HOST_WORKTREE_MARKER_ERROR, HOST_WORKTREE_MARKER_EXPORT, HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS } from "./ssh-host-worktree-constants.js";

const q = shellQuote;
const identity = GIT_SYNC_COMMIT_IDENTITY_ARGS.map(q).join(" ");
const errorLine = (code: string, detailExpr: string) => `printf '${HOST_WORKTREE_MARKER_ERROR}\\t%s\\t%s\\n' ${q(code)} ${detailExpr}`;

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
  const wipExcludes = HOST_WORKTREE_WIP_EXCLUDE_PATHSPECS.map(q).join(" ");
  const wt = q(input.worktreePath);
  const runDir = q(input.runDir);
  const wipRef = q(`refs/paperclip/wip/${input.runId}`);
  const exportRef = q(`refs/paperclip/export/${input.runId}`);
  const bundle = q(`${input.runDir}/export.bundle`);
  const idx = q(`${input.runDir}/wip.index`);
  const sizes = q(`${input.runDir}/wip.sizes`);
  const manifest = q(`${input.runDir}/export.refs`);
  const cap = Math.max(0, Math.trunc(input.wipMaxBytes));
  const start = input.startHeadSha ? q(input.startHeadSha) : null;
  return [
    "set -e",
    `if [ ! -e ${q(`${input.worktreePath}/.git`)} ]; then ${errorLine("host_worktree_missing", wt)}; exit 0; fi`,
    `mkdir -p ${runDir}`,
    `idx=${idx}`,
    `sizes=${sizes}`,
    `paths=${q(`${input.runDir}/wip.paths`)}`,
    `rm -f "$idx" "$sizes" ${bundle}`,
    `trap 'rm -f "$idx" "$sizes" "$paths"' EXIT`,
    `head=$(git -C ${wt} rev-parse --verify HEAD)`,
    `GIT_INDEX_FILE=${idx} git -C ${wt} read-tree "$head"`,
    `GIT_INDEX_FILE=${idx} git -C ${wt} ls-files -z --cached --others --exclude-standard -- . ${wipExcludes} > "$paths"`,
    `GIT_INDEX_FILE=${idx} git -C ${wt} --literal-pathspecs add -A --pathspec-from-file="$paths" --pathspec-file-nul`,
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
    `git -C ${wt} for-each-ref --format='%(objectname) %(refname)' refs/heads/ refs/tags/ refs/remotes/ > ${manifest}`,
    `set -- ${exportRef}`,
    `if [ -n "$wip" ]; then set -- "$@" ${wipRef}; fi`,
    `while read -r sha ref; do set -- "$@" "$ref"; done < ${manifest}`,
    'base=""',
    ...(start && !input.forceFullBundle
      ? [`if git -C ${wt} cat-file -e ${q(`${input.startHeadSha}^{commit}`)} 2>/dev/null; then base=$(git -C ${wt} merge-base ${start} "$head" 2>/dev/null || true); fi`]
      : []),
    'if [ -n "$base" ]; then',
    `  count=$(git -C ${wt} rev-list --objects "$@" --not "$base" | wc -l | tr -d ' ')`,
    "else",
    `  count=$(git -C ${wt} rev-list --objects "$@" | wc -l | tr -d ' ')`,
    "fi",
    'if [ "$count" -gt 0 ]; then',
    `  if [ -n "$base" ]; then git -C ${wt} bundle create ${bundle} "$@" --not "$base"; else git -C ${wt} bundle create ${bundle} "$@"; fi`,
    "else",
    `  : > ${bundle}`,
    "fi",
    `git -C ${wt} update-ref -d ${exportRef} >/dev/null 2>&1 || true`,
    `git -C ${wt} update-ref "refs/paperclip/known/$head" "$head"`,
    `if [ -n "$wip" ]; then git -C ${wt} update-ref "refs/paperclip/known/$wip" "$wip"; fi`,
    `size=$(wc -c < ${bundle} | tr -d ' ')`,
    `printf '${HOST_WORKTREE_MARKER_EXPORT}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$head" "$wip" "$([ -n "$wip" ] && echo 1 || echo 0)" "$size" "$branch"`,
    `while read -r sha ref; do printf 'PAPERCLIP_HOST_REF\\t%s\\t%s\\n' "$sha" "$ref"; done < ${manifest}`,
    `rm -f ${manifest}`,
  ].join("\n");
}

