import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULES, databaseUrl, isolatedEnvironment, capturePaths, UUID } from './callback-capture-policy.mjs';
import { tracedQueue, tracedRunner } from './callback-capture-trace.mjs';
import { CREATE_ROOT, SUPERVISOR, CLEAN_ROOT, PROBE } from './callback-capture-remote.mjs';

export async function installedRuntime(manifest, appRoot, outputDir, trace, env = process.env) {
  const connection = databaseUrl(env);
  if (!env.PAPERCLIP_API_KEY || !UUID.test(env.PAPERCLIP_RUN_ID ?? '')) throw new Error('Existing run authentication is required.');
  const origin = new URL(manifest.apiOrigin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('The controller origin must use loopback.');
  }
  const modules = {};
  for (const [key, relative] of Object.entries(MODULES)) modules[key] = await import(pathToFileURL(path.join(appRoot, relative)).href);
  const db = modules.db.createDb(connection, {maxConnections:1, connectTimeoutSeconds:5, idleTimeoutSeconds:5});
  const environments = modules.environments.environmentService(db);
  const runtime = modules.runtime.environmentRuntimeService(db);
  let original, isolated, config, rawRunner, runner;
  const paths = capturePaths(manifest);
  const bridgeToken = randomBytes(24).toString('hex');
  const controllerDeadline = performance.now() + 120000;
  let gatewayStarted = false, gatewayAttempted = false;
  const command = async (script, input, commandRunner = rawRunner, cwd = paths.root) => {
    const result = await commandRunner.execute({command:'node', args:['-e', script], cwd,
      stdin:JSON.stringify(input), timeoutMs:10000, bypassSession:true});
    if (result.exitCode !== 0 || result.timedOut) throw new Error('Diagnostic command failed.');
    return result.stdout;
  };
  return {
    save(result) {
      writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', {mode:0o600});
    },
    async createRoot() {
      original = await environments.getById(manifest.environmentId);
      if (!original) throw new Error('Registered environment is absent.');
      isolated = isolatedEnvironment(original, manifest);
      const parsed = await modules.config.resolveEnvironmentDriverConfigForRuntime(db, manifest.companyId, original);
      if (parsed.driver !== 'ssh') throw new Error('The registered driver must use SSH.');
      config = parsed.config;
      rawRunner = modules.ssh.createSshCommandManagedRuntimeRunner({spec:{...config, remoteCwd:manifest.remoteWorkspaceRoot}, maxBufferBytes:128*1024});
      runner = tracedRunner(rawRunner, trace);
      // No command reaches either original runtime directory. The first command creates an exclusive scratch root.
      await command(CREATE_ROOT, {...paths, captureId:manifest.captureId}, runner, manifest.remoteWorkspaceRoot);
    },
    async acquire() {
      const record = await runtime.acquireRunLease({companyId:manifest.companyId, environment:isolated,
        issueId:manifest.issueId, heartbeatRunId:null, persistedExecutionWorkspace:null, assertCompanyBinding:true});
      return record.lease;
    },
    validateLease(lease) {
      if (lease.provider !== 'ssh' || lease.metadata?.remoteCwd !== paths.root) throw new Error('Lease isolation differs.');
    },
    async startWorker(_, signal) {
      const client = tracedQueue(modules.bridge.createCommandManagedSandboxCallbackBridgeQueueClient({
        runner, remoteCwd:paths.root, shellCommand:'sh',
      }), trace);
      const issuePath = `/api/issues/${manifest.issueId}`;
      let writes = 0;
      return modules.bridge.startSandboxCallbackBridgeWorker({client, queueDir:paths.queue,
        handleRequest: (request, options) => trace.operation('host_handler', 'forward', async () => {
          const read = request.method === 'GET' && (request.path === issuePath ||
            (request.path.startsWith(`${issuePath}/comments/`) && UUID.test(request.path.slice(`${issuePath}/comments/`.length))));
          const write = request.method === 'POST' && request.path === `${issuePath}/comments`;
          if ((!read && !write) || request.query || signal.aborted) throw new Error('Diagnostic route denied.');
          if (write) {
            if (++writes !== 1) throw new Error('A repeated comment write is forbidden.');
            const body = JSON.parse(request.body.toString());
            const expected = `Approved callback diagnostic for ${manifest.issueKey}. Capture ${manifest.captureId}.`;
            if (body.body !== expected || body.clientRequestId !== manifest.captureId || Object.keys(body).length !== 2) {
              throw new Error('Diagnostic comment differs.');
            }
          }
          const response = await fetch(new URL(request.path, origin), {method:request.method, redirect:'error',
            headers:{authorization:`Bearer ${env.PAPERCLIP_API_KEY}`, 'content-type':'application/json', 'x-paperclip-run-id':env.PAPERCLIP_RUN_ID},
            ...(write ? {body:request.body} : {}),
            signal:AbortSignal.any([signal, options.signal, AbortSignal.timeout(10000)]),
          });
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 65536) throw new Error('Diagnostic response is too large.');
            chunks.push(chunk);
          }
          if (response.status < 200 || response.status >= 300) throw new Error('The controller refused the probe.');
          return {status:response.status, headers:{'content-type':'application/json'}, body:Buffer.concat(chunks)};
        }, {requestId:request.id, method:request.method, path:request.path}),
      });
    },
    async prepareSupervisor() {
      const remaining = Math.max(1, Math.floor(controllerDeadline - performance.now()));
      const source = SUPERVISOR.replace('setTimeout(stop, 120000)', `setTimeout(stop, ${remaining})`);
      const shim = `#!/bin/sh\nexec node '${paths.root}/supervisor.mjs' "$@"\n`;
      await command(String.raw`
        const fs=require('node:fs'); let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{
          const p=JSON.parse(s); fs.writeFileSync(p.root+'/supervisor.mjs',p.source,{flag:'wx',mode:0o600});
          fs.writeFileSync(p.root+'/node',p.shim,{flag:'wx',mode:0o700}); console.log('{}');
        });`, {root:paths.root, source, shim});
    },
    async startServer() {
      gatewayAttempted = true;
      const asset = await modules.bridge.createSandboxCallbackBridgeAsset();
      try {
        const server = await modules.bridge.startSandboxCallbackBridgeServer({runner, remoteCwd:paths.root,
          assetRemoteDir:paths.assets, queueDir:paths.queue, bridgeToken, bridgeAsset:asset,
          host:'127.0.0.1', port:0, nodeCommand:`${paths.root}/node`, shellCommand:'sh'});
        gatewayStarted = true;
        return server;
      } finally { await asset.cleanup(); }
    },
    async probe(p) {
      return JSON.parse(await command(PROBE, {...p, server:undefined, signal:undefined,
        baseUrl:p.server.baseUrl, token:bridgeToken, runId:env.PAPERCLIP_RUN_ID,
        authorAgentId:manifest.authorAgentId}, runner));
    },
    async cleanRoot(_, startAttempted, signal) {
      await runner.sealAndDrain(signal);
      if (signal?.aborted) throw new Error('Cleanup deadline reached.');
      await command(CLEAN_ROOT, {root:paths.root, captureId:manifest.captureId,
        startAttempted:startAttempted || gatewayAttempted || gatewayStarted}, rawRunner, manifest.remoteWorkspaceRoot);
    },
    async release(id) {
      const lease = await environments.releaseLease(id, 'released');
      if (!lease || lease.id !== id || lease.status !== 'released') throw new Error('Lease release is unconfirmed.');
    },
    async close() { await modules.db.closeRegisteredClients(connection); },
  };
}
