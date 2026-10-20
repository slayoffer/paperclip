// Public SSH API. Implementation modules preserve the existing exports.
export { type SshConnectionConfig, type SshCommandResult, type SshRemoteExecutionSpec, type SshEnvLabSupport, type SshEnvLabFixtureState, shellQuote, parseSshRemoteExecutionSpec } from "./ssh-config.js";
export { createSshCommandManagedRuntimeRunner, runSshCommand, buildSshSpawnTarget, ensureSshWorkspaceReady, fileExists } from "./ssh-command.js";
export { syncDirectoryToSsh, syncDirectoryFromSsh } from "./ssh-sync.js";
export { prepareWorkspaceForSshExecution, restoreWorkspaceFromSshExecution } from "./ssh-workspace.js";
export { getSshEnvLabSupport, buildKnownHostsEntry, readSshEnvLabFixtureState, stopSshEnvLabFixture, startSshEnvLabFixture, buildSshEnvLabFixtureConfig, readSshEnvLabFixtureStatus } from "./ssh-fixture.js";
