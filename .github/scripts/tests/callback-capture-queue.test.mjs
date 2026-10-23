import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'paperclip-callback-queue-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  return root;
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
    const rawClient=createCommandManagedSandboxCallbackBridgeQueueClient({runner,remoteCwd:root});
    // Publish the file before the trace can record the completed write.
    let releaseWrite;
    const observedResponse=new Promise(resolve=>{releaseWrite=resolve;});
    const writeResponse=rawClient.writeResponseFile;
    rawClient.writeResponseFile=async (...args)=>{
      const result=await writeResponse(...args);
      await observedResponse;
      return result;
    };
    const client=tracedQueue(rawClient,trace);
    const worker=await startSandboxCallbackBridgeWorker({client,queueDir:root+'/queue',
      handleRequest:request=>trace.operation('host_handler','forward',async()=>({status:200,body:'fixture'}),{requestId:request.id})});
    try {
      await writeFile(root+'/queue/requests/'+requestId+'.json', JSON.stringify({id:requestId,
        method:'GET',path:'/api/issues/'+randomUUID(),query:'',headers:{},body:'',createdAt:new Date().toISOString()}));
      let response, observedPendingTrace=false;
      for (let i=0;i<100;i++) {
        try {
          response=JSON.parse(await readFile(root+'/queue/responses/'+requestId+'.json','utf8'));
          if (!observedPendingTrace) {
            if (trace.requestIds.length!==0) throw Error('Expected a pending response trace');
            observedPendingTrace=true;
            releaseWrite();
          }
        } catch (error) {if (error.code!=='ENOENT') throw error;}
        if (response && trace.requestIds[0]===requestId) break;
        await new Promise(r=>setTimeout(r,20));
      }
      if (!observedPendingTrace || response?.status!==200 || trace.requestIds[0]!==requestId) throw Error('Queue proof failed');
      console.log('queue proof passed');
    } finally {releaseWrite(); await worker.stop();}
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
