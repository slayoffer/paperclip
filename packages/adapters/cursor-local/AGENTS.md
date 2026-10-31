# Cursor adapter test fixtures

Pass `input.stdin` to `runChildProcess` in sandbox runner fixtures.
Managed runtime sync sends archive bytes through standard input.
A fixture that drops this input creates an empty archive and fails during extraction.

Use the runner's installer simulation in managed-runtime execution fixtures.
Forward other shell commands to the real process runner so archive staging and restoration remain tested.
Without the simulation, a missing `agent` starts the live Cursor installer and makes tests depend on network downloads.
Measured on 2026-11-01 (VLAT): the managed-runtime fixture exceeded both five-second and 30-second deadlines during installation.
The simulated agent must consume prompt stdin before it exits. An immediate exit can cause an unhandled `EPIPE` in the process runner.
