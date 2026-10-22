import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULES, capturePaths } from '../../../scripts/callback-capture/callback-capture-policy.mjs';
import { installedRuntime } from '../../../scripts/callback-capture/callback-capture-runtime.mjs';
import { captureSession } from '../../../scripts/callback-capture/callback-capture-session.mjs';
import { createCaptureTrace } from '../../../scripts/callback-capture/callback-capture-trace.mjs';

async function installedFixture(t, outcome) {
  const root = await mkdtemp(path.join(tmpdir(), 'callback-runtime-test-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const manifest = {captureId:randomUUID(), companyId:randomUUID(), environmentId:randomUUID(),
    issueId:randomUUID(), authorAgentId:randomUUID(), issueKey:'SYNA-2370', host:'fixture-host',
    remoteWorkspaceRoot:'/Users/test/paperclip-work', remoteScratchRoot:'/Users/test/paperclip-scratch',
    environmentUpdatedAt:'2026-10-22T00:00:00.000Z', apiOrigin:'http://127.0.0.1:3100'};
  const leaseId = randomUUID();
  const stateFile = path.join(root, 'state.mjs');
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(stateFile, `export const calls = [];
    export const commands = [];
    export const manifest = ${JSON.stringify(manifest)};
    export const leaseId = ${JSON.stringify(leaseId)};
    export const outcome = ${JSON.stringify(outcome)};`);
  const stateImport = `import {calls, commands, manifest, leaseId, outcome} from ${JSON.stringify(pathToFileURL(stateFile).href)};`;
  // Simulate only installed service boundaries. Keep runtime methods and cleanup unchanged.
  const sources = {
    db: `export const createDb = () => ({}); export const closeRegisteredClients = async () => {};`,
    environments: `export const environmentService = () => ({
      getById: async () => ({id:manifest.environmentId, companyId:manifest.companyId,
        driver:'ssh', status:'active', updatedAt:new Date(manifest.environmentUpdatedAt),
        config:{host:manifest.host, remoteWorkspacePath:manifest.remoteWorkspaceRoot}}),
      releaseLease: async id => {calls.push('release'); return {id, status:'released'};},
    });`,
    runtime: `export const environmentRuntimeService = () => ({
      acquireRunLease: async () => {calls.push('acquire'); return {lease:{id:leaseId,
        provider:'ssh', metadata:{remoteCwd:manifest.remoteScratchRoot+'/'+manifest.issueKey+'/'+manifest.captureId}}};},
    });`,
    config: `export const resolveEnvironmentDriverConfigForRuntime = async () => ({driver:'ssh', config:{}});`,
    ssh: `export const createSshCommandManagedRuntimeRunner = () => ({execute:async input => {
      commands.push(input);
      if (input.args[1].includes('p.shim')) {calls.push('prepareSupervisor'); return outcome;}
      calls.push(commands.length === 1 ? 'createRoot' : 'cleanRoot');
      return {exitCode:0, timedOut:false, stdout:'{}'};
    }});`,
    bridge: `export const createCommandManagedSandboxCallbackBridgeQueueClient = () => ({});
      export const startSandboxCallbackBridgeWorker = () => ({stop:async () => calls.push('stopWorker')});`,
  };
  for (const [key, relative] of Object.entries(MODULES)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), {recursive:true});
    await writeFile(filename, stateImport + sources[key]);
  }
  const state = await import(pathToFileURL(stateFile).href);
  const filename = path.join(root, 'trace.jsonl');
  const trace = createCaptureTrace(filename, manifest.captureId);
  const runtime = await installedRuntime(manifest, root, root, trace, {
    DATABASE_URL:'postgres://fixture', PAPERCLIP_API_KEY:'fixture-only', PAPERCLIP_RUN_ID:randomUUID(),
  });
  return {manifest, runtime, trace, filename, leaseId, ...state};
}

for (const [label, outcome, uncertain] of [
  ['SSH exit 255', {exitCode:255, timedOut:false}, true],
  ['timeout', {exitCode:null, timedOut:true}, true],
  ['confirmed failure', {exitCode:1, timedOut:false}, false],
]) {
  test(`installed supervisor preparation tracks ${label} through cleanup`, async t => {
    const f = await installedFixture(t, outcome);
    const result = await captureSession(f.manifest, f.runtime, f.trace);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.cleanup, uncertain ? 'incomplete' : 'complete');
    assert.equal(result.leaseId, f.leaseId);
    assert.equal(result.remoteRoot, capturePaths(f.manifest).root);
    assert.equal(result.startAttempted, false);
    assert.equal(f.trace.failed, true);
    assert.deepEqual(f.calls, ['createRoot', 'acquire', 'prepareSupervisor', 'stopWorker',
      ...(uncertain ? [] : ['cleanRoot', 'release'])]);
    const preparation = f.commands[1];
    assert.equal(preparation.cwd, result.remoteRoot);
    assert.equal(preparation.bypassSession, true);
    assert.equal(JSON.parse(preparation.stdin).root, result.remoteRoot);
    const events = (await readFile(f.filename, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.stage === 'control_command' && e.event === 'start').length, 2);
    assert.ok(events.some(e => e.stage === 'control_command' && e.event === (outcome.timedOut ? 'timeout' : 'error')));
  });
}
