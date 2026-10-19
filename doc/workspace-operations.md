# Workspace operations

For sandbox file synchronization, lock ownership, and the required upgrade
procedure from directory locks, see [Workspace restore locks](workspace-restore-locks.md).

SSH workspace preparation and restore share two operation slots per server process.
The queue includes workspace transfers, baseline capture, and runtime assets.
Directory scans, file content reads, SHA-256 hashes, and SQLite manifest writes run in worker threads.
Each worker reads file contents with a fixed-size buffer.
Memory snapshots transfer metadata in small batches with acknowledgements.
Disk snapshots return a manifest descriptor after the worker closes the database.
Snapshot formats and restore merge rules stay the same.

Run logs show queue wait times and elapsed times for Git import, workspace sync,
baseline capture, and asset sync. Each step reports its start and its result.
The queue does not change the agent run cap or execution leases.
