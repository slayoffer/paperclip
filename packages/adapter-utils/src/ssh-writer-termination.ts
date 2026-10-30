import { randomUUID } from "node:crypto";
import path from "node:path";
import { shellQuote } from "./ssh-config.js";

export function sshWriterDirectory(remoteWorkspacePath: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid SSH writer run id");
  return path.posix.join(remoteWorkspacePath, ".paperclip-runtime", "ssh-writers", runId);
}

/** Record containment before provider execution. A systemd scope keeps detached
 * descendants in the same cgroup. Unsupported hosts retain an explicit unknown
 * record. Neither a session ID nor an SSH exit proves writer termination. */
export function trackSshWriterCommand(command: string, remoteWorkspacePath: string, runId?: string): string {
  if (!runId) return command;
  const directory = sshWriterDirectory(remoteWorkspacePath, runId);
  const invocation = randomUUID();
  const marker = path.posix.join(directory, invocation);
  const unit = `paperclip-writer-${invocation}.scope`;
  const record = `
    const fs = require('node:fs');
    const [marker, unit] = process.argv.slice(1);
    try {
      if (fs.statfsSync('/sys/fs/cgroup').type !== 0x63677270) process.exit(1);
      const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
      if (!group.startsWith('0::/') || group.includes('\\n')) process.exit(1);
      const cgroup = group.slice(3);
      if (!cgroup.endsWith('/' + unit) || cgroup.split('/').includes('..')) process.exit(1);
      const root = '/sys/fs/cgroup' + cgroup;
      if (!fs.readFileSync(root + '/cgroup.procs', 'utf8').trim().split('\\n').includes(String(process.pid))) process.exit(1);
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const mount = fs.statSync('/sys/fs/cgroup');
      fs.writeFileSync(marker, JSON.stringify({ version: 2, boot, pid: process.ppid, cgroup, hierarchy: [mount.dev, mount.ino] }));
    } catch { process.exit(1); }
  `;
  const writer = `node -e ${shellQuote(record)} ${shellQuote(marker)} ${shellQuote(unit)}; ${command}`;
  // Keep every wrapper command behind the caller's directory-change guard.
  return `{ ${[
    "umask 077",
    `mkdir -p ${shellQuote(directory)} || exit 125`,
    // Every invocation needs a record, including uncontained fallback commands.
    `printf 'uncontained\\n' > ${shellQuote(marker)} || exit 125`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    // Without a static description, systemd records command arguments and credentials in its journal.
    `if [ -r /sys/fs/cgroup/cgroup.controllers ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --help | grep -q -- --expand-environment && systemctl --user show-environment >/dev/null 2>&1; then exec systemd-run --user --scope --quiet --description='Paperclip SSH writer' --expand-environment=no --unit=${shellQuote(unit)} sh -c ${shellQuote(writer)}; else ${command}; fi`,
  ].join("; ")}; }`;
}

/** A cgroup includes descendants in new sessions and process groups. Its
 * populated counter includes nested cgroups. Existing incomplete or legacy records fail closed.
 * An absent directory proves no tracked writer started only for a confirmed terminal run. */
export function sshWriterTerminationScript(
  remoteWorkspacePath: string, runId: string, options: { allowMissingDirectory?: boolean } = {},
): string {
  const directory = sshWriterDirectory(remoteWorkspacePath, runId);
  const source = `
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = process.argv[1];
    try {
      try { fs.lstatSync(directory); }
      catch (error) {
        if (process.argv[3] !== '1' || error.code !== 'ENOENT' || !fs.statSync(process.argv[2]).isDirectory()) throw error;
        process.stdout.write('stopped\\n');
        process.exit(0);
      }
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (fs.statfsSync('/sys/fs/cgroup').type !== 0x63677270) process.exit(1);
      const names = fs.readdirSync(directory);
      if (!names.length) process.exit(1);
      for (const name of names) {
        if (!/^[0-9a-f-]{36}$/.test(name)) process.exit(1);
        const record = JSON.parse(fs.readFileSync(directory + '/' + name, 'utf8'));
        if (record.version !== 2 || !/^[0-9a-f-]{36}$/.test(record.boot) || typeof record.cgroup !== 'string' ||
            !record.cgroup.startsWith('/') || record.cgroup.split('/').includes('..') ||
            path.basename(record.cgroup) !== 'paperclip-writer-' + name + '.scope') process.exit(1);
        if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid <= 0)) process.exit(1);
        if (record.boot !== boot) continue;
        if (record.pid !== undefined) {
          try { process.kill(record.pid, 0); process.exit(1); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const mount = fs.statSync('/sys/fs/cgroup');
        if (!Array.isArray(record.hierarchy) || record.hierarchy.length !== 2 ||
            record.hierarchy[0] !== mount.dev || record.hierarchy[1] !== mount.ino) process.exit(1);
        const root = '/sys/fs/cgroup' + record.cgroup;
        try {
          if (!/^populated 0$/m.test(fs.readFileSync(root + '/cgroup.events', 'utf8'))) process.exit(1);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // A verified scope disappears only after its last descendant exits.
          // A missing events file in an existing group is uncertain evidence.
          try { fs.statSync(root); process.exit(1); }
          catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
        }
      }
      process.stdout.write('stopped\\n');
    } catch { process.exit(1); }
  `;
  return `node -e ${shellQuote(source)} ${shellQuote(directory)} ${shellQuote(remoteWorkspacePath)} ${options.allowMissingDirectory === true ? "1" : "0"}`;
}

/** SYNA-2959: stop every tracked writer scope of a run before a server restart, so the provider really exits and
 * the SSH command returns its own exit status. TERM first, KILL after the grace. It proves nothing by itself:
 * the caller confirms with sshWriterTerminationScript. Untracked ("uncontained") records are left alone. */
export function sshWriterStopScript(remoteWorkspacePath: string, runId: string, graceSec = 20): string {
  const directory = sshWriterDirectory(remoteWorkspacePath, runId);
  const grace = Math.max(1, Math.min(120, Math.floor(graceSec)));
  return [
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    `[ -d ${shellQuote(directory)} ] || exit 0`,
    // The leading-parenthesis case form keeps the pattern from closing a command substitution.
    `units() { for f in ${shellQuote(directory)}/*; do n=\${f##*/}; case "$n" in (????????-????-????-????-????????????) printf 'paperclip-writer-%s.scope\\n' "$n";; esac; done; }`,
    'for u in $(units); do systemctl --user kill --signal=SIGTERM "$u" 2>/dev/null; done',
    `i=0; while [ "$i" -lt ${grace} ]; do a=0; for u in $(units); do systemctl --user is-active --quiet "$u" && a=1; done; [ "$a" = 0 ] && break; sleep 1; i=$((i+1)); done`,
    'for u in $(units); do systemctl --user is-active --quiet "$u" && systemctl --user kill --signal=SIGKILL "$u" 2>/dev/null; done',
    "exit 0",
  ].join("; ");
}
