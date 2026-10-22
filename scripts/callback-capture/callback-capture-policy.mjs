import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MODULES = {
  db: 'packages/db/src/index.ts',
  environments: 'server/dist/services/environments.js',
  runtime: 'server/dist/services/environment-runtime.js',
  config: 'server/dist/services/environment-config.js',
  ssh: 'packages/adapter-utils/src/ssh.ts',
  bridge: 'packages/adapter-utils/src/sandbox-callback-bridge.ts',
};
export const REQUIRED_FILES = [...Object.values(MODULES),
  'packages/db/src/client.ts', 'packages/adapter-utils/src/ssh-command.ts',
  'packages/adapter-utils/src/execution-target.ts',
  'server/dist/services/environment-ssh-driver.js',
  'packages/adapter-utils/package.json', 'packages/adapters/codex-local/package.json',
  'server/dist/build-info.json', 'server/node_modules/tsx/dist/loader.mjs'];

export function capturePaths(manifest) {
  for (const field of ['captureId', 'companyId', 'environmentId', 'issueId', 'authorAgentId']) {
    if (!UUID.test(manifest[field])) throw new Error('Invalid capture identifier.');
  }
  if (!/^SYNA-[1-9][0-9]*$/.test(manifest.issueKey)) throw new Error('Invalid issue key.');
  const workspace = manifest.remoteWorkspaceRoot;
  const scratch = manifest.remoteScratchRoot;
  for (const value of [workspace, scratch]) {
    if (typeof value !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(value) || path.posix.normalize(value) !== value || value === '/') {
      throw new Error('Invalid diagnostic path.');
    }
  }
  const inside = (a, b) => a === b || a.startsWith(`${b}/`);
  if (inside(scratch, workspace) || inside(workspace, scratch)) throw new Error('Diagnostic paths overlap.');
  const root = path.posix.join(scratch, manifest.issueKey, manifest.captureId);
  return { root, queue: `${root}/queue`, assets: `${root}/assets`, parent: path.posix.dirname(root) };
}

// This check has no database imports, network calls, or executable module imports.
export async function checkInstalledIdentity(manifest, appRoot) {
  capturePaths(manifest);
  if (!/^[a-f0-9]{40}$/.test(manifest.revision) || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageDigest)) {
    throw new Error('Invalid build identity.');
  }
  if (manifest.nodeVersion !== process.version) throw new Error('Installed Node version differs.');
  const root = await realpath(appRoot);
  for (const relative of REQUIRED_FILES) {
    const expected = manifest.hashes?.[relative];
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Missing module identity.');
    const filename = await realpath(path.join(root, relative));
    if (!filename.startsWith(`${root}/`)) throw new Error('Module escapes the installed root.');
    const actual = createHash('sha256').update(await readFile(filename)).digest('hex');
    if (actual !== expected) throw new Error('Installed module identity differs.');
  }
  const stamp = JSON.parse(await readFile(path.join(root, 'server/dist/build-info.json'), 'utf8'));
  if (stamp.commit !== manifest.revision) throw new Error('Installed revision differs.');
  return { revision: manifest.revision, imageDigest: manifest.imageDigest, nodeVersion: process.version };
}

export function isolatedEnvironment(environment, manifest) {
  const { root } = capturePaths(manifest);
  if (environment.id !== manifest.environmentId || environment.driver !== 'ssh' || environment.status !== 'active' ||
      (environment.companyId && environment.companyId !== manifest.companyId) ||
      environment.config.host !== manifest.host || environment.config.remoteWorkspacePath !== manifest.remoteWorkspaceRoot ||
      environment.updatedAt.toISOString() !== manifest.environmentUpdatedAt) {
    throw new Error('Registered environment differs.');
  }
  // The driver receives a copy. No registered environment update occurs.
  return { ...environment, config: { ...environment.config, remoteWorkspacePath: root } };
}

export function databaseUrl(env) {
  if (!env.DATABASE_URL || !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL)) {
    throw new Error('An existing PostgreSQL connection is required.');
  }
  return env.DATABASE_URL;
}

export function diagnosticArgv(appRoot, entrypoint, manifestPath, outputRoot) {
  return ['--import', path.join(appRoot, 'server/node_modules/tsx/dist/loader.mjs'),
    entrypoint, '--child', manifestPath, appRoot, outputRoot];
}
