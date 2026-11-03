# Fork repository verification

Keep the required `repository-verification` check and its exact PR-head checkout.
Run all six verification shards and reject failed, cancelled, skipped, or missing results.
On 2026-11-02, the unsharded launcher hit its 150-minute limit after 149 of 164 serialized suites.
Use the existing fork release sharding pattern instead of increasing the time limit.
An in-progress Actions log can omit recent output until its next upload. Check the completed log before diagnosing a stalled test.
Vitest 5.0.3 `list --filesOnly` ignores `--shard`. To check coverage, compare the full file list with the union from the configured Vitest sequencer.
