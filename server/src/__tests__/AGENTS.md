# Test rules

## Owned process Stop fixtures

`resumeQueuedRuns()` returns before asynchronous adapter preparation finishes.
Await the fixture's process readiness signal before checking `runningProcesses`.
A short registry poll can fail before the process starts and skip the Stop assertions.
Keep the test timeout and all cancellation settlement assertions.
