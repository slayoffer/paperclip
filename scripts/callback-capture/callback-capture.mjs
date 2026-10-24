#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInstalledIdentity, diagnosticArgv, databaseUrl } from './callback-capture-policy.mjs';
import { createCaptureTrace } from './callback-capture-trace.mjs';
import { captureSession } from './callback-capture-session.mjs';
import { installedRuntime } from './callback-capture-runtime.mjs';

async function main() {
  const [mode, manifestPath, appRoot, outputRoot, expectedManifestHash] = process.argv.slice(2);
  if (!['--check', '--execute', '--child'].includes(mode) || !manifestPath || !appRoot) {
    throw new Error('Use --check or --execute with the manifest and installed root.');
  }
  const rawManifest = await readFile(manifestPath);
  const manifestHash = createHash('sha256').update(rawManifest).digest('hex');
  if (mode === '--child' && manifestHash !== expectedManifestHash) throw new Error('Capture manifest changed.');
  const manifest = JSON.parse(rawManifest);
  const identity = await checkInstalledIdentity(manifest, appRoot);
  if (mode === '--check') {
    console.log(JSON.stringify({identity, manifestHash, importedInstalledModules:false}));
    return;
  }
  databaseUrl(process.env);
  if (mode === '--execute') {
    if (!outputRoot) throw new Error('A separate local output root is required.');
    const parent = await realpath(outputRoot);
    const app = await realpath(appRoot);
    if (parent === app || parent.startsWith(`${app}/`)) throw new Error('Output overlaps the installed root.');
    const output = path.join(parent, manifest.captureId);
    await mkdir(output, {mode:0o700});
    const kernelBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const initStat = await readFile('/proc/1/stat', 'utf8');
    const controllerStartTicks = initStat.slice(initStat.lastIndexOf(')') + 2).split(' ')[19];
    await writeFile(path.join(output, 'identity.json'), JSON.stringify({...identity, manifestHash,
      controllerBootId:`${kernelBootId}:${controllerStartTicks}`, diagnosticRunId:randomUUID(),
      adapterPackageRevision:manifest.revision, transport:'queue_v1',
      runnerImplementation:'createSshCommandManagedRuntimeRunner', hashes:manifest.hashes}, null, 2), {flag:'wx', mode:0o600});
    const args = diagnosticArgv(app, fileURLToPath(import.meta.url), await realpath(manifestPath), output);
    args.push(manifestHash);
    // The parent owns this process group. No shell parses the argument vector.
    const child = spawn(process.execPath, args, {cwd:app, env:process.env, detached:true, stdio:'ignore'});
    const stop = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    const terminate = () => stop('SIGTERM');
    process.once('SIGTERM', terminate);
    process.once('SIGINT', terminate);
    const activeTimer = setTimeout(() => stop('SIGTERM'), 120000);
    const killTimer = setTimeout(() => stop('SIGKILL'), 150000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
    }).finally(() => {
      clearTimeout(activeTimer); clearTimeout(killTimer);
      process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
    });
    await writeFile(path.join(output, 'process.json'), JSON.stringify(result), {mode:0o600});
    process.exitCode = result.code === 0 ? 0 : 1;
    console.log(JSON.stringify({captureId:manifest.captureId, process:result}));
    return;
  }
  const output = await realpath(outputRoot);
  if (path.basename(output) !== manifest.captureId) throw new Error('Output identity differs.');
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const trace = createCaptureTrace(path.join(output, 'trace.jsonl'), manifest.captureId);
  let runtime;
  try {
    runtime = await installedRuntime(manifest, appRoot, output, trace);
    const result = await captureSession(manifest, runtime, trace, {signal:controller.signal});
    process.exitCode = result.outcome === 'not_reproduced' && result.cleanup === 'complete' ? 0 : 1;
  } finally { await runtime?.close(); }
}

main().catch(() => {
  // Arbitrary import, provider, and database errors can contain credentials.
  process.stderr.write('Diagnostic launcher failed. Preserve its output for inspection.\n');
  process.exitCode = 1;
});
