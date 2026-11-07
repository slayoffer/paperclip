import { shellQuote } from "./ssh-config.js";

/** Resolve existing ancestors on the host before creating runtime directories. */
export function sshRuntimeIsolationScript(worktree: string, directories: string[]): string {
  for (const value of [worktree, ...directories]) {
    if (!value.startsWith("/") || /[\r\n]/.test(value)) throw new Error("Invalid SSH runtime path");
  }
  return [
    "set -eu",
    "canonical_directory() {",
    '  candidate="$1"',
    '  suffix=""',
    '  while [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; do',
    '    suffix="/$(basename -- "$candidate")$suffix"',
    '    candidate=$(dirname -- "$candidate")',
    "  done",
    '  resolved=$(cd -- "$candidate" && pwd -P) || return 1',
    '  printf "%s%s\\n" "${resolved%/}" "$suffix"',
    "}",
    `worktree=$(canonical_directory ${shellQuote(worktree)})`,
    ...directories.flatMap((directory) => [
      `runtime=$(canonical_directory ${shellQuote(directory)})`,
      'case "$runtime/" in "$worktree/"*) echo runtime_root_inside_worktree; exit 1;; esac',
      // A runtime must also stay outside an unrelated repository.
      `candidate=${shellQuote(directory)}`,
      'while [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; do candidate=$(dirname -- "$candidate"); done',
      'if git -C "$candidate" rev-parse --show-toplevel >/dev/null 2>&1; then echo runtime_root_inside_repository; exit 1; fi',
      'printf "%s\\n" "$runtime"',
    ]),
  ].join("\n");
}
