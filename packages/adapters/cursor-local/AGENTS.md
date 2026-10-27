# Cursor adapter test fixtures

Pass `input.stdin` to `runChildProcess` in sandbox runner fixtures.
Managed runtime sync sends archive bytes through standard input.
A fixture that drops this input creates an empty archive and fails during extraction.
