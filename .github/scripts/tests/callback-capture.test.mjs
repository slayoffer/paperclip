import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capturePaths, isolatedEnvironment, databaseUrl, checkInstalledIdentity, REQUIRED_FILES, UUID,
  diagnosticArgv } from '../../../scripts/callback-capture/callback-capture-policy.mjs';
import { createCaptureTrace, tracedRunner, tracedQueue } from '../../../scripts/callback-capture/callback-capture-trace.mjs';
import { captureSession } from '../../../scripts/callback-capture/callback-capture-session.mjs';
import { CREATE_ROOT, CLEAN_ROOT, PROBE, SUPERVISOR } from '../../../scripts/callback-capture/callback-capture-remote.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = () => ({captureId:randomUUID(), companyId:randomUUID(), environmentId:randomUUID(),
  issueId:randomUUID(), authorAgentId:randomUUID(), issueKey:'SYNA-2370', host:'registered-host',
  remoteWorkspaceRoot:'/Users/test/paperclip-work', remoteScratchRoot:'/Users/test/paperclip-scratch',
  environmentUpdatedAt:'2026-10-22T00:00:00.000Z', revision:'a'.repeat(40), imageDigest:`sha256:${'b'.repeat(64)}`,
  nodeVersion:process.version});

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'callback-capture-test-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  return root;
}

test('diagnostic paths reject overlap, traversal, shell syntax, and old lease identifiers', () => {
  const m = manifest();
  assert.equal(capturePaths(m).root, `${m.remoteScratchRoot}/${m.issueKey}/${m.captureId}`);
  for (const change of [{remoteScratchRoot:m.remoteWorkspaceRoot},
    {remoteScratchRoot:`${m.remoteWorkspaceRoot}/scratch`}, {remoteScratchRoot:'/Users/test/../test'},
    {remoteScratchRoot:"/Users/test/scratch'"}, {captureId:'old-lease'}]) {
    assert.throws(() => capturePaths({...m, ...change}));
  }
});

test('the isolated environment copy preserves the registered configuration', () => {
  const m = manifest();
  const original = {id:m.environmentId, companyId:m.companyId, driver:'ssh', status:'active',
    config:{host:m.host, remoteWorkspacePath:m.remoteWorkspaceRoot}, updatedAt:new Date(m.environmentUpdatedAt)};
  const before = structuredClone(original);
  assert.equal(isolatedEnvironment(original, m).config.remoteWorkspacePath, capturePaths(m).root);
  assert.deepEqual(original, before);
  for (const change of [{driver:'sandbox'}, {status:'paused'}, {companyId:randomUUID()},
    {config:{...original.config, host:'other-host'}}, {updatedAt:new Date(0)}]) {
    assert.throws(() => isolatedEnvironment({...original, ...change}, m));
  }
});

test('the launcher requires an existing database and uses a separate process argument vector', () => {
  assert.throws(() => databaseUrl({}));
  assert.throws(() => databaseUrl({DATABASE_URL:'sqlite://local'}));
  assert.equal(databaseUrl({DATABASE_URL:'postgres://fixture'}), 'postgres://fixture');
  assert.deepEqual(diagnosticArgv('/app', '/capture/tool.mjs', '/capture/manifest.json', '/capture/out'),
    ['--import', '/app/server/node_modules/tsx/dist/loader.mjs', '/capture/tool.mjs', '--child',
      '/capture/manifest.json', '/app', '/capture/out']);
});

test('module identity rejects absent and changed files before executable imports', async t => {
  const root = await temporary(t);
  const m = {...manifest(), hashes:{}};
  for (const name of REQUIRED_FILES) {
    await mkdir(path.dirname(path.join(root, name)), {recursive:true});
    const body = name.endsWith('build-info.json') ? JSON.stringify({commit:m.revision}) : 'throw Error("must not import")';
    await writeFile(path.join(root, name), body);
    m.hashes[name] = createHash('sha256').update(body).digest('hex');
  }
  assert.equal((await checkInstalledIdentity(m, root)).revision, m.revision);
  await writeFile(path.join(root, REQUIRED_FILES[0]), 'changed');
  await assert.rejects(checkInstalledIdentity(m, root), /identity differs/);
  delete m.hashes[REQUIRED_FILES[0]];
  await assert.rejects(checkInstalledIdentity(m, root), /Missing module identity/);
});

test('queue and SSH trace preserve parent operations and exclude raw content', async t => {
  const filename = path.join(await temporary(t), 'trace.jsonl');
  const trace = createCaptureTrace(filename, randomUUID());
  const id = randomUUID();
  const runner = tracedRunner({execute:async () => ({exitCode:0, stdout:'SECRET output', stderr:'SECRET'})}, trace);
  const queue = tracedQueue({
    readTextFile:async () => { await runner.execute({bypassSession:true, command:'SECRET command'}); return '{"body":"SECRET body"}'; },
    writeResponseFile:async () => ({wrote:true}),
  }, trace);
  await queue.readTextFile(`/queue/${id}.json`);
  await trace.operation('host_handler', 'forward', async () => ({status:200, body:'SECRET'}), {requestId:id});
  await queue.writeResponseFile(`/response/${id}.json`, 'SECRET');
  assert.deepEqual(trace.requestIds, [id]);
  const raw = await readFile(filename, 'utf8');
  assert.ok(!raw.includes('SECRET'));
  const events = raw.trim().split('\n').map(JSON.parse);
  const control = events.find(e => e.stage === 'control_command' && e.event === 'start');
  assert.equal(control.parentId, events[0].operationId);
  assert.equal(control.bypassSession, true);
  assert.equal(events.filter(e => e.event === 'start').length, events.filter(e => e.event === 'end').length);
});

test('trace limits stop further probes and preserve the event and byte caps', async t => {
  const filename = path.join(await temporary(t), 'trace.jsonl');
  const trace = createCaptureTrace(filename, randomUUID(), {maxEvents:12});
  await trace.operation('directory_list', 'listJsonFiles', async () => []);
  await trace.operation('directory_list', 'listJsonFiles', async () => []);
  await assert.rejects(trace.operation('directory_list', 'listJsonFiles', async () => []), /limit/);
  assert.equal(trace.failed, true);
  const raw = await readFile(filename);
  assert.ok(raw.length <= 256 * 1024);
  assert.ok(trace.count <= 12);
});

test('cleanup waits for commands and refuses an uncertain SSH outcome', async t => {
  const trace = createCaptureTrace(path.join(await temporary(t), 'trace.jsonl'), randomUUID());
  let finish;
  const runner = tracedRunner({execute:() => new Promise(resolve => {finish=resolve;})}, trace);
  const command = runner.execute({});
  await new Promise(resolve => setImmediate(resolve));
  let drained = false;
  const drain = runner.sealAndDrain().then(() => {drained=true;});
  await assert.rejects(runner.execute({}), /sealed/);
  assert.equal(drained, false);
  finish({exitCode:0, timedOut:false});
  await command;
  await drain;
  assert.equal(drained, true);
  const uncertain = tracedRunner({execute:async () => ({exitCode:null, timedOut:true})}, trace);
  await assert.rejects(uncertain.execute({}));
  await assert.rejects(uncertain.sealAndDrain(), /uncertain/);
});

function simulated(m) {
  const calls = [];
  const commentId = randomUUID();
  const runtime = {
    save:() => {}, createRoot:async () => calls.push('createRoot'),
    acquire:async () => { calls.push('acquire'); return {id:randomUUID()}; },
    startWorker:async () => ({stop:async () => calls.push('stopWorker')}),
    prepareSupervisor:async () => calls.push('prepareSupervisor'),
    startServer:async () => ({host:'127.0.0.1', port:45123}),
    probe:async p => { calls.push(p.method); return {status:200, id:p.path.endsWith(m.issueId) ? m.issueId : commentId, matches:true}; },
    cleanRoot:async () => calls.push('cleanRoot'), release:async () => calls.push('release'),
  };
  return {runtime, calls, trace:{failed:false, requestIds:[randomUUID(), randomUUID(), randomUUID()]}};
}

test('uncertain SSH results preserve the diagnostic directory and lease', async t => {
  const root = await temporary(t);
  const outcomes = [
    {exitCode:255, timedOut:false, signal:null},
    {exitCode:null, timedOut:false, signal:null},
    {timedOut:false, signal:null},
    {exitCode:0, timedOut:false, signal:'SIGTERM'},
    {exitCode:null, timedOut:false, signal:'SIGKILL'},
    {exitCode:-1, timedOut:false, signal:null},
    {exitCode:256, timedOut:false, signal:null},
  ];
  for (const [index, outcome] of outcomes.entries()) {
    const m = manifest();
    const {runtime, calls} = simulated(m);
    const trace = createCaptureTrace(path.join(root, `trace-${index}.jsonl`), m.captureId);
    const runner = tracedRunner({execute:async () => outcome}, trace);
    runtime.prepareSupervisor = () => runner.execute({});
    runtime.cleanRoot = async (_paths, _started, signal) => {
      await runner.sealAndDrain(signal);
      calls.push('cleanRoot');
    };
    const result = await captureSession(m, runtime, trace);
    const message = JSON.stringify(outcome);
    assert.equal(result.outcome, 'failed', message);
    assert.equal(result.cleanup, 'incomplete', message);
    assert.equal(result.remoteRoot, capturePaths(m).root, message);
    assert.ok(UUID.test(result.leaseId), message);
    assert.equal(trace.failed, true, message);
    assert.deepEqual(calls, ['createRoot', 'acquire', 'stopWorker'], message);
    await assert.rejects(runner.sealAndDrain(), /uncertain/, message);
  }
});

test('a known SSH command failure permits directory removal and lease release', async t => {
  const m = manifest();
  const {runtime, calls} = simulated(m);
  const trace = createCaptureTrace(path.join(await temporary(t), 'trace.jsonl'), m.captureId);
  const runner = tracedRunner({execute:async () => ({exitCode:1, timedOut:false, signal:null})}, trace);
  runtime.prepareSupervisor = () => runner.execute({});
  runtime.cleanRoot = async (_paths, _started, signal) => {
    await runner.sealAndDrain(signal);
    calls.push('cleanRoot');
  };
  const result = await captureSession(m, runtime, trace);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.cleanup, 'complete');
  assert.equal(trace.failed, true);
  assert.deepEqual(calls, ['createRoot', 'acquire', 'stopWorker', 'cleanRoot', 'release']);
});

test('three successful probes read the saved comment and release only the diagnostic lease', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  const result = await captureSession(m, runtime, trace);
  assert.equal(result.outcome, 'not_reproduced');
  assert.equal(result.cleanup, 'complete');
  assert.deepEqual(calls, ['createRoot', 'acquire', 'prepareSupervisor', 'GET', 'POST', 'GET', 'stopWorker', 'cleanRoot', 'release']);
});

test('an indeterminate comment write stops without repeating the write', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  const probe = runtime.probe;
  runtime.probe = p => { if (p.method === 'POST') { calls.push('POST'); throw Error('uncertain'); } return probe(p); };
  const result = await captureSession(m, runtime, trace);
  assert.equal(result.outcome, 'failed');
  assert.equal(calls.filter(c => c === 'POST').length, 1);
  assert.equal(calls.filter(c => c === 'GET').length, 1);
  assert.equal(result.cleanup, 'complete');
});

test('a first failed read prevents the comment write', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.probe = async () => ({status:503});
  assert.equal((await captureSession(m, runtime, trace)).outcome, 'failed');
  assert.ok(!calls.includes('POST'));
});

test('missing trace evidence fails acceptance even when every probe passes', async () => {
  const m = manifest();
  const {runtime, trace} = simulated(m);
  trace.requestIds = [];
  assert.equal((await captureSession(m, runtime, trace)).outcome, 'failed');
});

test('cleanup failure retains the lease and identifies the retained directory', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.cleanRoot = async () => { throw Error('stop_unconfirmed'); };
  const result = await captureSession(m, runtime, trace);
  assert.equal(result.cleanup, 'incomplete');
  assert.equal(result.remoteRoot, capturePaths(m).root);
  assert.ok(result.leaseId);
  assert.ok(!calls.includes('release'));
});

test('an uncertain lease insertion preserves its root without repeating acquisition', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.acquire = async () => { calls.push('acquire'); throw Error('uncertain database write'); };
  const result = await captureSession(m, runtime, trace);
  assert.equal(result.cleanup, 'incomplete');
  assert.equal(result.leaseId, null);
  assert.equal(calls.filter(c => c === 'acquire').length, 1);
  assert.ok(!calls.includes('cleanRoot'));
  assert.ok(!calls.includes('release'));
});

test('a lease validation failure records its identifier before disposal', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.validateLease = () => { throw Error('isolation differs'); };
  const result = await captureSession(m, runtime, trace);
  assert.ok(UUID.test(result.leaseId));
  assert.equal(result.cleanup, 'complete');
  assert.ok(calls.includes('release'));
  assert.ok(!calls.includes('GET'));
});

test('late startup settles before cleanup and cannot start a probe after the deadline', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.startWorker = async () => {
    await new Promise(r => setTimeout(r, 30));
    return {stop:async () => calls.push('stopWorker')};
  };
  const result = await captureSession(m, runtime, trace, {captureMs:5, cleanupMs:100});
  assert.equal(result.cleanup, 'complete');
  assert.ok(calls.includes('stopWorker'));
  assert.ok(!calls.includes('GET'));
});

test('an unresolved root operation produces incomplete cleanup without a second operation', async () => {
  const m = manifest();
  const {runtime, calls, trace} = simulated(m);
  runtime.createRoot = () => new Promise(() => {});
  const result = await captureSession(m, runtime, trace, {captureMs:5, cleanupMs:5});
  assert.equal(result.cleanup, 'incomplete');
  assert.ok(!calls.includes('acquire'));
  assert.ok(!calls.includes('cleanRoot'));
});

async function remoteScript(script, input) {
  const child = spawn(process.execPath, ['-e', script], {stdio:['pipe', 'pipe', 'pipe']});
  child.stdin.end(JSON.stringify(input));
  let stdout = '';
  child.stdout.on('data', c => stdout += c);
  return new Promise(resolve => child.once('exit', code => resolve({code, stdout})));
}

test('remote cleanup refuses another capture marker and preserves sibling files', async t => {
  const parent = await temporary(t);
  const root = `${parent}/capture`;
  const captureId = randomUUID();
  await writeFile(`${parent}/sibling`, 'keep');
  assert.equal((await remoteScript(CREATE_ROOT, {root, parent, captureId})).code, 0);
  assert.notEqual((await remoteScript(CREATE_ROOT, {root, parent, captureId})).code, 0);
  assert.notEqual((await remoteScript(CLEAN_ROOT, {root, captureId:randomUUID(), startAttempted:false})).code, 0);
  assert.equal((await remoteScript(CLEAN_ROOT, {root, captureId, startAttempted:false})).code, 0);
  assert.equal(await readFile(`${parent}/sibling`, 'utf8'), 'keep');
});

test('remote scripts parse and supervisor owns a detached child group', () => {
  for (const script of [CREATE_ROOT, CLEAN_ROOT, PROBE]) assert.doesNotThrow(() => new Function(script));
  assert.match(SUPERVISOR, /detached:true/);
  assert.match(SUPERVISOR, /process\.kill\(-child\.pid/);
});

for (const readiness of [true, false]) {
  test(`supervisor stops its real child group with readiness=${readiness}`, {timeout:4000}, async t => {
    const parent = await temporary(t);
    const root = `${parent}/capture`;
    const captureId = randomUUID();
    await remoteScript(CREATE_ROOT, {root, parent, captureId});
    await writeFile(`${root}/supervisor.mjs`, SUPERVISOR);
    await writeFile(`${root}/gateway.mjs`, `import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(`${root}/child.json`)}, JSON.stringify({pid:process.pid}));
      ${readiness ? `fs.writeFileSync(${JSON.stringify(`${root}/ready`)}, '{}');` : ''}
      setInterval(()=>{},100);`);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},100)'], {stdio:'ignore'});
    const supervisor = spawn(process.execPath, [`${root}/supervisor.mjs`, `${root}/gateway.mjs`], {stdio:'ignore'});
    const exited = new Promise(resolve => supervisor.once('exit', resolve));
    t.after(() => { unrelated.kill(); supervisor.kill(); });
    let pid;
    for (let i = 0; i < 100; i++) {
      try { pid = JSON.parse(await readFile(`${root}/child.json`, 'utf8')).pid; break; } catch {}
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(pid);
    assert.equal((await remoteScript(CLEAN_ROOT, {root, captureId, startAttempted:true})).code, 0);
    await exited;
    assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  });
}

test('trace wrappers preserve the real command queue and worker interfaces', {timeout:15000}, async t => {
  const root = await temporary(t);
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const code = String.raw`
    import {spawn} from 'node:child_process';
    import {randomUUID} from 'node:crypto';
    import {readFile, writeFile} from 'node:fs/promises';
    import {pathToFileURL} from 'node:url';
    const {createCommandManagedSandboxCallbackBridgeQueueClient, startSandboxCallbackBridgeWorker} =
      await import(pathToFileURL(process.cwd() + '/packages/adapter-utils/src/sandbox-callback-bridge.ts'));
    const {createCaptureTrace, tracedRunner, tracedQueue} =
      await import(pathToFileURL(process.cwd() + '/scripts/callback-capture/callback-capture-trace.mjs'));
    const root=process.argv[1], requestId=randomUUID();
    const trace=createCaptureTrace(root+'/trace.jsonl', randomUUID());
    const runner=tracedRunner({execute: input=>new Promise((resolve,reject)=>{
      const child=spawn(input.command,input.args,{cwd:input.cwd,env:{PATH:process.env.PATH}});
      let stdout='',stderr='';
      child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
      child.stdin.end(input.stdin);
      const timer=setTimeout(()=>child.kill(),1000);
      child.on('error',reject); child.on('close',code=>{
        clearTimeout(timer); resolve({exitCode:code,stdout,stderr,timedOut:false});
      });
    })},trace);
    const client=tracedQueue(createCommandManagedSandboxCallbackBridgeQueueClient({runner,remoteCwd:root}),trace);
    const worker=await startSandboxCallbackBridgeWorker({client,queueDir:root+'/queue',
      handleRequest:request=>trace.operation('host_handler','forward',async()=>({status:200,body:'fixture'}),{requestId:request.id})});
    try {
      await writeFile(root+'/queue/requests/'+requestId+'.json', JSON.stringify({id:requestId,
        method:'GET',path:'/api/issues/'+randomUUID(),query:'',headers:{},body:'',createdAt:new Date().toISOString()}));
      let response;
      for (let i=0;i<100;i++) {
        try {response=JSON.parse(await readFile(root+'/queue/responses/'+requestId+'.json','utf8')); break;} catch {}
        await new Promise(r=>setTimeout(r,20));
      }
      if (response?.status!==200 || trace.requestIds[0]!==requestId) throw Error('Queue proof failed');
      console.log('queue proof passed');
    } finally {await worker.stop();}
  `;
  const child = spawn(process.execPath, ['--import', `${repository}/server/node_modules/tsx/dist/loader.mjs`,
    '--input-type=module', '-e', code, root], {cwd:repository, env:{PATH:process.env.PATH}});
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c);
  child.stderr.on('data', c => stderr += c);
  t.after(() => child.kill());
  const codeResult = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(codeResult, 0, stderr);
  assert.match(stdout, /queue proof passed/);
});
