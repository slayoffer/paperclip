import { capturePaths, UUID } from './callback-capture-policy.mjs';

function deadline(promise, ms, signal) {
  let timer;
  let abort;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Capture deadline reached.')), ms);
    abort = () => reject(new Error('Capture aborted.'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, {once:true});
  })]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

// The dependency boundary lets tests prove disposal without SSH or database writes.
export async function captureSession(manifest, runtime, trace, limits = {}) {
  const paths = capturePaths(manifest);
  const result = { captureId: manifest.captureId, outcome: 'failed', leaseId: null,
    remoteRoot: paths.root, startAttempted: false, cleanup: 'pending', probes: [] };
  const controller = new AbortController();
  let server, worker, rootCreated = false, leasePending;
  const pending = new Set();
  let accepting = !limits.signal?.aborted;
  const active = (fn) => {
    if (!accepting || trace.failed) throw new Error('Capture stopped.');
    const task = Promise.resolve().then(fn);
    pending.add(task);
    return task.finally(() => pending.delete(task));
  };
  const save = () => runtime.save(result);
  const capture = async () => {
    result.rootAttempted = true;
    await active(async () => { await runtime.createRoot(paths); rootCreated = true; });
    await active(async () => {
      // Save a late lease result even after the deadline. Never repeat acquisition.
      leasePending = runtime.acquire(paths).then(lease => {
        result.leaseId = lease.id;
        save();
        runtime.validateLease?.(lease);
        return lease;
      });
      await leasePending;
    });
    if (!UUID.test(result.leaseId)) throw new Error('Invalid diagnostic lease.');
    save();
    await active(async () => { worker = await runtime.startWorker(paths, controller.signal); });
    await active(() => runtime.prepareSupervisor(paths));
    result.startAttempted = true;
    save();
    await active(async () => { server = await runtime.startServer(paths); });
    if (server.host !== '127.0.0.1' || !Number.isInteger(server.port) || server.port <= 0 || server.port === 54960) {
      throw new Error('Invalid diagnostic endpoint.');
    }
    result.port = server.port;
    const body = `Approved callback diagnostic for ${manifest.issueKey}. Capture ${manifest.captureId}.`;
    const issuePath = `/api/issues/${manifest.issueId}`;
    const probe = async (method, path, data, expectedBody) => {
      const response = await active(() => runtime.probe({server, method, path, body:data, expectedBody, signal:controller.signal}));
      result.probes.push({method, status:response.status});
      save();
      if (response.status < 200 || response.status >= 300 || trace.failed) throw new Error('Diagnostic probe failed.');
      return response;
    };
    const issue = await probe('GET', issuePath);
    if (issue.id !== manifest.issueId) throw new Error('Issue identity differs.');
    const comment = await probe('POST', `${issuePath}/comments`, {body, clientRequestId:manifest.captureId}, body);
    if (!UUID.test(comment.id) || comment.matches !== true) throw new Error('Saved comment identity differs.');
    const readback = await probe('GET', `${issuePath}/comments/${comment.id}`, undefined, body);
    if (readback.id !== comment.id || readback.matches !== true) throw new Error('Saved comment differs.');
    if (trace.requestIds.length !== 3) throw new Error('Required stage records are absent.');
    result.requestIds = trace.requestIds;
    result.outcome = 'not_reproduced';
  };
  try {
    await deadline(capture(), Math.min(limits.captureMs ?? 120000, 120000), limits.signal);
  } catch {
    result.outcome = 'failed';
  } finally {
    accepting = false;
    controller.abort();
    // Stop probes first. Each disposal has its own limit. A failure preserves the root and lease.
    let disposing = true;
    const cleanupController = new AbortController();
    const checkDisposal = () => { if (!disposing) throw new Error('Cleanup deadline reached.'); };
    const dispose = async () => {
      await Promise.allSettled([...pending]);
      checkDisposal();
      await worker?.stop({drainTimeoutMs:1000});
      checkDisposal();
      if (result.rootAttempted && !rootCreated) throw new Error('Root creation outcome is unknown.');
      if (leasePending && !result.leaseId) throw new Error('Lease acquisition outcome is unknown.');
      if (rootCreated) await runtime.cleanRoot(paths, result.startAttempted, cleanupController.signal);
      checkDisposal();
      // A timed-out lease insertion can finish during teardown. Do not release an unknown lease.
      if (leasePending && !result.leaseId) await leasePending;
      checkDisposal();
      if (result.leaseId) await runtime.release(result.leaseId);
      result.cleanup = 'complete';
    };
    try { await deadline(dispose(), Math.min(limits.cleanupMs ?? 30000, 30000)); }
    catch { disposing = false; cleanupController.abort(); result.cleanup = 'incomplete'; }
    if (trace.failed || result.cleanup !== 'complete') result.outcome = 'failed';
    save();
  }
  return result;
}
