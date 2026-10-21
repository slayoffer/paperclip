import { randomUUID } from "node:crypto";
import path from "node:path";
import { shellQuote } from "./ssh-config.js";

export function sshWriterDirectory(remoteWorkspacePath: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid SSH writer run id");
  return path.posix.join(remoteWorkspacePath, ".paperclip-runtime", "ssh-writers", runId);
}

/** A dedicated Linux session keeps child process groups within the writer scope.
 * The identity survives adapter cleanup and controller restarts. No timestamp
 * or SSH client exit grants termination authority. Unsupported hosts keep the
 * original command and cannot supply a receipt. */
export function trackSshWriterCommand(command: string, remoteWorkspacePath: string, runId?: string): string {
  if (!runId) return command;
  const directory = sshWriterDirectory(remoteWorkspacePath, runId);
  const marker = path.posix.join(directory, randomUUID());
  const writer = [
    "umask 077",
    `mkdir -p ${shellQuote(directory)} || exit 125`,
    `printf '%s\\n%s\\n' "$(cat /proc/sys/kernel/random/boot_id)" "$$" > ${shellQuote(marker)} || exit 125`,
    command,
  ].join("; ");
  return `if [ -r /proc/sys/kernel/random/boot_id ] && command -v setsid >/dev/null 2>&1; then exec setsid --wait sh -c ${shellQuote(writer)}; else ${command}; fi`;
}

/** Check every recorded session. A surviving child prevents release even when
 * its original provider process exited. Read errors preserve ownership. */
export function sshWriterTerminationScript(remoteWorkspacePath: string, runId: string): string {
  const directory = sshWriterDirectory(remoteWorkspacePath, runId);
  const source = `
    const fs = require('node:fs');
    const directory = process.argv[1];
    try {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const names = fs.readdirSync(directory);
      if (!names.length) process.exit(1);
      const sessions = new Set();
      for (const name of names) {
        const lines = fs.readFileSync(directory + '/' + name, 'utf8').trim().split('\\n');
        if (lines.length !== 2 || !/^[0-9a-f-]{36}$/.test(lines[0]) || !/^[1-9][0-9]*$/.test(lines[1])) process.exit(1);
        if (lines[0] === boot) sessions.add(lines[1]);
      }
      for (const pid of fs.readdirSync('/proc').filter(p => /^[0-9]+$/.test(p))) {
        let stat;
        try { stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\\s+/);
        if (fields.length < 4) process.exit(1);
        if (sessions.has(fields[3])) process.exit(1);
      }
      for (const session of sessions) {
        try { process.kill(-Number(session), 0); process.exit(1); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      process.stdout.write('stopped\\n');
    } catch { process.exit(1); }
  `;
  return `node -e ${shellQuote(source)} ${shellQuote(directory)}`;
}
