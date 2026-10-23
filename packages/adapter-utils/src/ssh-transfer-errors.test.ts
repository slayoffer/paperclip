import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// Real child pipes fail in a separate parent process. No uncaught-error handler masks a crash.
it.each(["upload", "restore", "file"].flatMap((kind) =>
  [false, true].flatMap((progress) => [false, true].map((ignoreTerm) => ({ kind, progress, ignoreTerm })))),
)("contains a broken $kind pipe, progress=$progress, ignores termination=$ignoreTerm", async ({ kind, progress, ignoreTerm }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-transfer-error-"));
  directories.push(root);
  const bin = path.join(root, "bin");
  const source = path.join(root, "source");
  await mkdir(bin);
  await mkdir(source);
  // More than a child pipe can buffer. The receiving process closes fd 0 before it exits.
  await writeFile(path.join(source, "payload"), Buffer.alloc(8 * 1024 * 1024, 42));
  const realTar = (await exec("sh", ["-c", "command -v tar"])).stdout.trim();
  await writeFile(path.join(bin, "tar"), `#!/bin/sh
if [ "$PIPE_PEER_CLOSE" = 1 ] && [ "$1" = -xf ]; then
  if [ "$PIPE_IGNORE_TERM" = 1 ]; then trap '' TERM; fi
  echo $$ > "$PIPE_PEER_PID"
  exec 0<&-
  exec sleep 120
fi
exec '${realTar}' "$@"
`, { mode: 0o700 });
  await writeFile(path.join(bin, "ssh"), `#!/bin/sh
for arg do command=$arg; done
if [ "$PIPE_PEER_CLOSE" = 1 ] && [ "$TRANSFER_KIND" != restore ]; then
  if [ "$PIPE_IGNORE_TERM" = 1 ]; then trap '' TERM; fi
  echo $$ > "$PIPE_PEER_PID"
  exec 0<&-
  exec sleep 120
fi
exec /bin/sh -c "$command"
`, { mode: 0o700 });

  const syncModule = new URL("./ssh-sync.ts", import.meta.url).href;
  const transferModule = new URL("./ssh-transfer-progress.ts", import.meta.url).href;
  const loader = new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const script = `
    import { readFile, readdir } from 'node:fs/promises';
    import { createServer } from 'node:http';
    const { syncDirectoryToSsh, syncDirectoryFromSsh } = await import(${JSON.stringify(syncModule)});
    const { streamLocalFileToSsh, createTransferProgress } = await import(${JSON.stringify(transferModule)});
    const root = ${JSON.stringify(root)};
    const kind = ${JSON.stringify(kind)};
    const withProgress = ${JSON.stringify(progress)};
    const spec = { host: 'fixture', username: 'fixture', port: 22,
      remoteCwd: root, remoteWorkspacePath: root,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true };
    const logs = [];
    const onProgress = withProgress ? (line) => { logs.push(line); } : undefined;
    const transfer = async () => {
      if (kind === 'file') {
        const progress = onProgress ? createTransferProgress({ onProgress, phase: 'Importing git history',
          direction: 'to', totalBytes: null, estimated: false }) : undefined;
        try {
          await streamLocalFileToSsh({ spec, localFile: root + '/source/payload',
            remoteScript: "cat > '" + root + "/result'", progress });
          await progress?.finish();
        } catch (error) { await progress?.fail(); throw error; }
      } else {
        const operation = kind === 'upload' ? syncDirectoryToSsh : syncDirectoryFromSsh;
        await operation({ spec, localDir: root + (kind === 'upload' ? '/source' : '/destination'),
          remoteDir: root + (kind === 'upload' ? '/destination' : '/source'), onProgress });
      }
    };
    const server = createServer((request, response) => {
      if (request.url === '/health') { response.end('ok'); return; }
      void transfer().then(() => response.end('complete'), (error) => {
        console.error('Transfer failed:', error.code, error.message);
        response.writeHead(502).end(JSON.stringify({ code: error.code, message: error.message }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    let failure;
    let health;
    try {
      const failed = await fetch(url + '/transfer');
      if (failed.status !== 502) throw new Error('The broken transfer unexpectedly succeeded.');
      failure = await failed.json();
      const peerPid = Number(await readFile(root + '/peer-pid', 'utf8'));
      try { process.kill(peerPid, 0); throw new Error('The failed transfer returned before its peer stopped.'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      health = await (await fetch(url + '/health')).text();
      process.env.PIPE_PEER_CLOSE = '0';
      const recovered = await fetch(url + '/transfer');
      if (await recovered.text() !== 'complete') throw new Error('The next transfer failed.');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    const expected = await readFile(root + '/source/payload');
    const received = await readFile(root + (kind === 'file' ? '/result' : '/destination/payload'));
    const leftovers = (await readdir(root)).filter((name) => name.startsWith('paperclip-ssh-sync-back-'));
    console.log(JSON.stringify({ failure, health, healthy: received.equals(expected), logs, leftovers }));
  `;
  const { stdout, stderr } = await exec(process.execPath,
    ["--import", loader, "--input-type=module", "-e", script], {
      timeout: 20_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
        PIPE_PEER_CLOSE: "1", TRANSFER_KIND: kind, PIPE_PEER_PID: path.join(root, "peer-pid"),
        PIPE_IGNORE_TERM: ignoreTerm ? "1" : "0" },
    });
  const result = JSON.parse(stdout.trim());
  expect(result.failure.code).toBe("EPIPE");
  expect(result.health).toBe("ok");
  expect(result.healthy).toBe(true);
  expect(result.leftovers).toEqual([]);
  expect(stderr).toContain("Transfer failed: EPIPE");
  expect(stderr).not.toContain("Unhandled");
  if (progress) expect(result.logs.join("")).toMatch(/failed/i);
}, 30_000);
