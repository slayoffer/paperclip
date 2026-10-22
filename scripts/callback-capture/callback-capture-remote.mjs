// These scripts run only after the privileged operator approves the exact capture.
export const CREATE_ROOT = String.raw`
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const {root, parent, captureId} = JSON.parse(input);
  fs.mkdirSync(parent, {recursive:true, mode:0o700});
  if (fs.realpathSync(parent) !== parent) throw Error('parent');
  fs.mkdirSync(root, {mode:0o700});
  fs.writeFileSync(root + '/owner.json', JSON.stringify({captureId}), {flag:'wx', mode:0o600});
  console.log('{}');
});`;

// A supervisor owns the gateway child and its process group. Cleanup never kills a recorded PID.
// This also covers a gateway that starts but never publishes readiness.
export const SUPERVISOR = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root = path.dirname(new URL(import.meta.url).pathname);
const child = spawn(process.execPath, process.argv.slice(2), {
  detached:true, stdio:'inherit', env:process.env,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000).unref();
}
child.on('error', () => {
  fs.writeFileSync(root + '/stopped.json', '{}', {mode:0o600});
  process.exit(1);
});
child.on('exit', () => {
  fs.writeFileSync(root + '/stopped.json', '{}', {mode:0o600});
  process.exit(0);
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setTimeout(stop, 120000);
setInterval(() => { if (fs.existsSync(root + '/stop')) stop(); }, 50);
`;

export const CLEAN_ROOT = String.raw`
const fs = require('node:fs');
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', async () => {
  const {root, captureId, startAttempted} = JSON.parse(input);
  if (fs.realpathSync(root) !== root) throw Error('root');
  if (JSON.parse(fs.readFileSync(root + '/owner.json', 'utf8')).captureId !== captureId) throw Error('owner');
  if (startAttempted) {
    fs.writeFileSync(root + '/stop', '', {mode:0o600});
    const until = Date.now() + 8000;
    while (!fs.existsSync(root + '/stopped.json') && Date.now() < until) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!fs.existsSync(root + '/stopped.json')) throw Error('stop_unconfirmed');
  }
  // No link traversal. The capture owns this directory and its contents exclusively.
  fs.rmSync(root, {recursive:true});
  console.log('{}');
});`;

export const PROBE = String.raw`
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', async () => {
  const p = JSON.parse(input);
  try {
    const response = await fetch(p.baseUrl + p.path, {
      method:p.method, redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{authorization:'Bearer ' + p.token, 'content-type':'application/json', 'x-paperclip-run-id':p.runId},
      ...(p.body ? {body:JSON.stringify(p.body)} : {}),
    });
    let bytes = 0;
    const chunks = [];
    for await (const c of response.body) {
      bytes += c.length;
      if (bytes > 65536) throw Error('size');
      chunks.push(c);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const result = {status:response.status, id:body.id};
    if (p.expectedBody) result.matches = body.body === p.expectedBody && body.authorAgentId === p.authorAgentId;
    console.log(JSON.stringify(result));
  } catch { process.exitCode = 1; }
});`;
