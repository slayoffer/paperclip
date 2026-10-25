# Workspace restore locks

Workspace restore and agent-file collection serialize writes to each canonical
target directory. Their lock files live in
`<instance root>/locks/directory-merge`, outside the writable target. All writers
must use the same instance root and a filesystem with reliable SQLite file
locking. Network filesystems that do not provide that locking are not supported.

Each target has a permanent `<hash>.lock.sqlite` file. An open SQLite
`BEGIN IMMEDIATE` transaction holds its reserved file lock for the entire write
operation. Contenders retry without blocking the Node event loop, up to the
15-minute default. `PAPERCLIP_RESTORE_LOCK_WAIT_MS` overrides this limit in
milliseconds. Set a positive safe integer. Invalid values retain the default.
The setting uses the caller environment. Closing the connection releases the lock. The operating
system also releases it when the process exits or crashes. Independent targets
use different files and can proceed concurrently.

This uses the same built-in `node:sqlite` dependency as workspace manifests.
See [SQLite file locking](https://www.sqlite.org/lockingv3.html) for the reserved
lock contract. No application database or schema migration is involved.

The adjacent `<hash>.lock.owner.json` records a PID and creation time only for
bounded timeout diagnostics. Missing, stale, or incorrect metadata cannot grant
or retain ownership. PID reuse, PID namespaces, and wall-clock changes do not
decide whether a writer owns the lock.

**Never delete, replace, or move a `.lock.sqlite` file while an instance can
write to it.** Its stable inode is part of the locking contract. Replacing it
could let two writers lock different files for the same target. Files remain
after release, including for targets that no longer exist. Their diagnostic
owner sidecars are normally removed after release.

## Restore contention and timings

Directory merges reserve a shared operation slot before they request the lock.
A nested SSH restore retains its existing slot. The locked merge never waits
for another operation slot.

A private target scan hashes content before lock acquisition. The locked scan
checks each file's device, inode, size, mode, and nanosecond modification and
change timestamps. It reuses a hash only when all fields match the same local
target. A changed file requires a new hash. A file that changes during hashing
fails the optional cache scan. Concurrent renames during that scan discard
that cache. The locked scan then reads content again.

Metadata stays in a private temporary manifest. Serialized baselines cannot
supply metadata authority. Merge rules and baseline hashes remain unchanged.
The private manifest is removed after success or failure.

Run logs report `Workspace merge lock wait` and `Workspace merge lock hold`.
Each line uses the existing step format and reports elapsed milliseconds.
Failure lines retain timing evidence. These lines contain no target paths,
process identifiers, or owner metadata. A log failure cannot retain the lock.

## Upgrade from directory locks

Older versions created `<hash>.lock/owner.json` and checked only whether the
recorded PID existed. A server restart could reuse that PID and leave an orphaned
lock permanently protected. Those records cannot establish a process lifetime or
PID namespace, so the new implementation never guesses that a legacy holder is
dead. An existing legacy directory continues to block admission.

Do not run old and new lock protocols concurrently against the same instance
root. An old process does not participate in the SQLite lock protocol.

1. Drain and stop **all** old server and worker processes that can write to the
   instance root, including processes on other hosts or in other containers.
2. Preserve any unfinished-run evidence needed for recovery. After all writers
   are stopped, move leftover legacy `<hash>.lock/` directories to an operator
   scratch directory outside the lock root. Do not remove `.lock.sqlite` files.
3. Start all writers on the new version. Verify that a run completes both the
   provider turn and file collection/restore. A successful model response alone
   does not prove that its local file changes were saved.

The same drain requirement applies to rollback. Existing permanent SQLite files
can remain on disk; older versions ignore them. Do not infer that a legacy lock
is safe to remove from its age, an absent PID, or a successful task response.

This change prevents new orphaned ownership. It cannot recover file changes
that an earlier failed collection discarded.
