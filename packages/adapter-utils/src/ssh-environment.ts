import { randomUUID } from "node:crypto";
import { isValidShellEnvKey, shellQuote, type SshCommandResult } from "./ssh-config.js";

type Execute = (command: string, stdin?: string) => Promise<SshCommandResult>;

/** Transfer every value through stdin, including secret bindings with custom names. */
export async function stageSshEnvironment(env: Record<string, string>, execute: Execute): Promise<{
  wrap: (command: string) => string;
  cleanup: () => Promise<void>;
}> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  for (const [key, value] of entries) {
    if (!isValidShellEnvKey(key)) throw new Error(`Invalid SSH environment variable key: ${key}`);
    if (value.includes("\0")) throw new Error(`Invalid SSH environment variable value for: ${key}`);
  }
  if (!entries.length) return { wrap: (command) => command, cleanup: async () => {} };

  const directory = `/tmp/paperclip-ssh-env.${randomUUID()}`;
  const file = shellQuote(`${directory}/environment`);
  const remove = `/bin/rm -f ${file} && /bin/rmdir ${shellQuote(directory)}`;
  const cleanup = async () => { await execute(`${remove} 2>/dev/null`).catch(() => undefined); };
  const upload = [
    "set +x",
    "umask 077",
    `paperclip_env_dir=${shellQuote(directory)}`,
    'mkdir -m 700 "$paperclip_env_dir" || exit 125',
    'trap \'/bin/rm -f "$paperclip_env_dir/environment"; /bin/rmdir "$paperclip_env_dir"\' 0',
    "trap 'exit 125' HUP INT TERM",
    'cat > "$paperclip_env_dir/environment" || exit 125',
    'chmod 600 "$paperclip_env_dir/environment" || exit 125',
    "trap - 0 HUP INT TERM",
  ].join("\n");
  const payload = entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n") + "\n";
  try {
    await execute(upload, payload);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    // Shell builtins read values without placing them in a child process argv.
    // Disable profile tracing before the shell reads any credential values.
    wrap: (command) => `{ set +x; . ${file} && ${remove} && ${command}; }`,
    cleanup,
  };
}
