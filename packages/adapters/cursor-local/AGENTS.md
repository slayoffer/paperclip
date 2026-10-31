# Cursor adapter test fixtures

Pass `input.stdin` to `runChildProcess` in sandbox runner fixtures.
Managed runtime sync sends archive bytes through standard input.
A fixture that drops this input creates an empty archive and fails during extraction.

Use `createFreshLeaseSandboxRunner` for managed-runtime execution tests.
It simulates the Cursor installer and preserves real archive reads.
An unrestricted shell fixture runs the live installer and can exceed the test timeout.
Measured on 2026-10-30 (VLAT).
