// Keep these patterns identical for workspace transfers and baseline snapshots.
// The `*/` variants also match nested paths in the local snapshot matcher.
export const SSH_WORKSPACE_EXCLUDES = [
  "node_modules", "dist", "build", "out", "coverage", ".next", ".turbo", ".cache",
  ".pnpm-store", "__pycache__", ".venv",
].flatMap((name) => [name, `${name}/*`, `*/${name}`, `*/${name}/*`]);
