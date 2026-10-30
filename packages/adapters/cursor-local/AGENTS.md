# Cursor adapter test fixtures

Pass `input.stdin` to `runChildProcess` in sandbox runner fixtures.
Managed runtime sync sends archive bytes through standard input.
A fixture that drops this input creates an empty archive and fails during extraction.

Replace `SANDBOX_INSTALL_COMMAND` with `buildInstallSimulationCommand` in shell fixtures.
Otherwise, managed runtime setup executes the external installer and depends on network latency.
Measured on 2026-10-30 (VLAT): the managed-home test exceeded its five-second deadline.
