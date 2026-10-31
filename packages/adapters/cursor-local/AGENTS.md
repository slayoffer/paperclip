# Cursor adapter test fixtures

Pass `input.stdin` to `runChildProcess` in sandbox runner fixtures.
Managed runtime sync sends archive bytes through standard input.
A fixture that drops this input creates an empty archive and fails during extraction.

Fake agent scripts must read their prompt from standard input before they exit.
An early exit can cause `EPIPE` while the runner writes the prompt.
The execution fixtures perform real filesystem and subprocess operations.
Allow 30 seconds for install and resume fixtures.
Allow 60 seconds for the managed-runtime round trip, which runs several archive commands.
