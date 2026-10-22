import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { UUID } from './callback-capture-policy.mjs';

export function createCaptureTrace(filename, captureId, limits = {}) {
  const context = new AsyncLocalStorage();
  const maxEvents = Math.min(limits.maxEvents ?? 512, 512);
  const maxBytes = Math.min(limits.maxBytes ?? 256 * 1024, 256 * 1024);
  let events = 0, bytes = 0, reserved = 0, sequence = 0, failure = false;
  const proof = new Map();
  const started = performance.now();
  function emit(event) {
    const line = JSON.stringify({ captureId, timestamp: new Date().toISOString(),
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, ...event }) + '\n';
    const size = Buffer.byteLength(line);
    if (events >= maxEvents || bytes + size > maxBytes) {
      failure = true;
      throw new Error('Diagnostic trace limit reached.');
    }
    appendFileSync(filename, line, { mode: 0o600 });
    events++; bytes += size;
    if (event.event === 'end' && event.requestId && ['request_read', 'host_handler', 'response_write'].includes(event.stage)) {
      const stages = proof.get(event.requestId) ?? new Set();
      if (event.stage !== 'response_write' || event.wrote === true) stages.add(event.stage);
      proof.set(event.requestId, stages);
    }
  }
  return {
    get failed() { return failure; },
    get count() { return events; },
    get requestIds() { return [...proof].filter(([, stages]) => stages.size === 3).map(([id]) => id); },
    async operation(stage, action, fn, safe = {}) {
      // Reserve one terminal event for each active operation. Reserve cleanup space too.
      if (events + reserved + 2 > maxEvents - 8 || bytes + (reserved + 2) * 1024 > maxBytes - 8192) {
        failure = true;
        throw new Error('Diagnostic trace limit reached.');
      }
      const operationId = ++sequence;
      const parentId = context.getStore()?.operationId ?? null;
      const fields = { stage, action, operationId, parentId };
      // Never spread an input object into the trace.
      if (UUID.test(safe.requestId ?? '')) fields.requestId = safe.requestId;
      if (typeof safe.bypassSession === 'boolean') fields.bypassSession = safe.bypassSession;
      if (['GET', 'POST'].includes(safe.method)) fields.method = safe.method;
      if (typeof safe.path === 'string' && /^\/api\/issues\/[a-f0-9-]{36}(?:\/comments(?:\/[a-f0-9-]{36})?)?$/.test(safe.path)) {
        fields.path = safe.path;
      }
      if (Number.isSafeInteger(safe.bytes) && safe.bytes >= 0) fields.bytes = safe.bytes;
      if (Number.isInteger(safe.status) && safe.status >= 100 && safe.status <= 599) {
        fields.status = safe.status;
        fields.responseKind = safe.status >= 500 ? 'recovery' : 'handler';
      }
      emit({ ...fields, event: 'start' });
      reserved++;
      const start = performance.now();
      try {
        const result = await context.run({ operationId }, fn);
        const extra = {};
        if (stage === 'directory_list' && Array.isArray(result)) {
          extra.count = result.length;
          extra.requestIds = result.filter(x => UUID.test(x.replace(/\.json$/, ''))).slice(0, 3);
        }
        if (stage === 'request_read' && action === 'fileSize' && Number.isSafeInteger(result)) extra.bytes = result;
        if (stage === 'response_write' && action === 'writeResponseFile') extra.wrote = result?.wrote === true;
        if (stage === 'request_read' && action === 'readTextFile') {
          extra.bytes = Buffer.byteLength(result);
          try { JSON.parse(result); extra.parseSuccess = true; } catch { extra.parseSuccess = false; }
          if (!extra.parseSuccess) throw new Error('Invalid queue envelope.');
        }
        if (stage === 'host_handler' || stage === 'control_command') {
          if (Number.isInteger(result?.status)) extra.status = result.status;
          if (Number.isInteger(result?.exitCode)) extra.exitCode = result.exitCode;
          if (result?.timedOut || (stage === 'control_command' && result?.exitCode !== 0)) {
            throw new Error(result?.timedOut ? 'timeout' : 'command_failed');
          }
        }
        emit({ ...fields, event: 'end', durationMs: Math.round(performance.now() - start), ...extra });
        return result;
      } catch (error) {
        failure = true;
        emit({ ...fields, event: error?.name === 'TimeoutError' || error?.message === 'timeout' ? 'timeout' : 'error',
          durationMs: Math.round(performance.now() - start) });
        throw error;
      } finally { reserved--; }
    },
  };
}

export function tracedRunner(runner, trace) {
  const pending = new Set();
  let sealed = false, uncertain = false;
  return {
    execute(input) {
      if (sealed) return Promise.reject(new Error('Diagnostic runner is sealed.'));
      return trace.operation('control_command', 'execute', async () => {
        const task = Promise.resolve().then(() => runner.execute(input));
        pending.add(task);
        try {
          const result = await task;
          if (result.timedOut) uncertain = true;
          return result;
        } catch (error) { uncertain = true; throw error; }
        finally { pending.delete(task); }
      }, { bypassSession: input.bypassSession === true });
    },
    async sealAndDrain(signal) {
      sealed = true;
      await Promise.allSettled([...pending]);
      if (signal?.aborted || uncertain) throw new Error('Diagnostic commands remain uncertain.');
    },
  };
}

export function tracedQueue(client, trace) {
  const result = {};
  for (const key of ['makeDir', 'makeDirs', 'listJsonFiles', 'fileSize', 'readTextFile',
    'writeTextFile', 'writeResponseFile', 'rename', 'remove']) {
    if (!client[key]) continue;
    result[key] = (...args) => {
      const stage = key === 'listJsonFiles' ? 'directory_list' :
        ['fileSize', 'readTextFile'].includes(key) ? 'request_read' :
        ['writeTextFile', 'writeResponseFile', 'rename'].includes(key) ? 'response_write' : 'queue_setup';
      const requestId = typeof args[0] === 'string' ? args[0].split('/').at(-1).replace(/\.json$/, '') : null;
      const safe = {requestId};
      if (stage === 'response_write' && typeof args[1] === 'string') {
        safe.bytes = Buffer.byteLength(args[1]);
        try { safe.status = JSON.parse(args[1]).status; } catch {}
      }
      return trace.operation(stage, key, () => client[key](...args), safe);
    };
  }
  return result;
}
