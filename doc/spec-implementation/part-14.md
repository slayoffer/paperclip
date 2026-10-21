# Implementation specification: part 14

### Filesystem access boundary (2026-10-20)

Filesystem isolation belongs to the OS, execution environment, and storage layout.
Paperclip authorizes the current task/run, company, explicitly selected configuration,
execution policy, and repository credentials. It does not infer file permissions from
other tasks or agents that previously used the same directory, overlapping roots,
symlink aliases, or shared Git storage. Existing files under an authorized task root
may be read subject to OS access and API path containment.

Private task records, comments, attachments, run logs, full workspace metadata, and
operation logs retain their app authorization. Workspace `_issuePrivacySources` and
operation privacy metadata protect app-record disclosure; they do not grant or deny
filesystem execution or task-bound file browsing. Current trust and sandbox policy,
publication receipts, binding checks, and lifecycle locks remain authoritative.

A task's organizational project and filesystem workspace are independent. New tasks that need a filesystem and have no selected/configured workspace get a company/task directory, not the agent home. Plain tasks need neither Git nor a project. Existing bindings and admitted roots remain authoritative; changing project does not move files. Explicit workspace selections apply at a subsequent normal admission after prior execution and persistence obligations settle.

The remote default also uses a task-owned empty source for an authorized project
with no configured workspaces or explicit workspace policy. Its derived managed
folder is not an admitted source. Existing bindings, explicit source selections,
and required Git or folder settings do not become empty-source fallbacks.

Chat connection and destination settings may supply project/workspace defaults. Destination fields override connection fields; omitted values inherit and null clears the inherited choice. Resolve and authorize these defaults once for a new conversation, then retain the resulting task intent. Existing conversations do not change when settings change. Trust confinement still takes precedence.

Agents inspect/select workspaces and request contained repository preparation through ordinary authorized APIs. Repository preparation is idempotent and may require the next admission; it never claims a host-only clone is available in an already-running remote session. Simultaneous tasks may still explicitly share one physical local/SSH folder. Remote sharing requires actual placement and coherent persistence capability.

See [the layer architecture](../plans/2026-10-09-task-workspaces.md) for resolution rules, module ownership, persistence versions, rollout, and verification.

### Experimental native remote workspace authority (2026-10-30)

The managed feature `remoteWorkspaceStorageEnabled` defaults on for Cloud and
self-hosted instances. New native Paperclip Runner sandbox workspaces use remote
authority automatically when durable storage is configured and their fresh
source is supported. Existing host workspaces and configured local folders keep
their legacy path until explicitly imported. An explicit stored `false` disables
new enrollment; managed configuration can override the stored choice. External
PostgreSQL records workspace identity, location, writer epoch, and the committed
saved version; S3 holds encrypted portable snapshots. A stable deployment
encryption key is required. The webserver uses disposable transfer/restore
scratch instead of a durable task checkout. New workspaces without these
prerequisites retain the legacy path. The local, SSH, and plugin environment
drivers, legacy adapters, and Dot retain their existing behavior.

One writer owns a logical workspace. Preparation establishes a saved baseline;
finalization saves supported changes before settling persistence. A webserver
replacement reconnects to the existing allocation. A committed saved version can
restore elsewhere without the old sandbox or Git remote, including supported
dirty Git state and unpushed commits. Changes after the last save still depend
on the live allocation; this release provides no periodic backup of those edits.
Failed saving retains the source and recovery obligation before destructive
cleanup. File browsing distinguishes live bytes from a saved copy and its time.
After a final save, older failed copies can expire when all their save attempts
have stopped. Cleanup retains copies whose upload completion is unknown. This
includes operations from older builds without save-attempt records. A final
save alone does not prove that an older upload has stopped.

V1 supports plain task folders, Git sources, and managed mutable repositories.
An authorized mentioned project's configured Git repositories become writable
copies inside the task workspace, under `.paperclip-repositories/`. The copies
retain their saved files, paths, refs and pins on subsequent turns. Preparation
rechecks the access and trust policy of each retained source project. This does
not grant permission to change a shared source folder or push to a repository.
Repositories attached on a later turn are acquired before they become part of
the next committed archive. Snapshot coverage is separate from the requested
source recipe. New copies honor `repoRef`, then `defaultRef`, then the remote's
default branch; an invalid ref cannot publish a partial secondary checkout.
It rejects explicitly read-only sources,
explicit concurrent shared writers, and custom cleanup/teardown commands on
remote close. Manual workspace runtime commands, jobs, and services are also
unsupported in V1 and must fail before local filesystem work. Agent tasks remain
the supported command path. Disabling new enrollment preserves existing authority
and recovery. An enrolled workspace whose persistence prerequisites are lost
must fail admission rather than fall back to a controller checkout.

A reference to an authorized project with no configured workspace source does
not attach a folder. It adds a resolution warning and preserves the task's
workspace. A configured cross-project local folder must be imported before remote
acquisition. `PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE` gates configured
sources; a source-less project reference needs no folder and stays metadata-only
when that switch is off.

Task failure notices show the redacted workspace validation explanation when
preparation fails. Existing retry permissions and execution gates still apply.
This includes retained-folder access and trust denials. Low-trust project boundary
denials retain their separate project-access action.

An imported saved Git workspace can resume from its saved files after its old
local repository is removed. Local repository paths remain invalid for new
remote acquisition. Saves reject unfinished Git operations, including rebase,
cherry-pick, revert, merge, and bisect. The source files remain protected. Finish
or abort the Git operation before saving. V1 does not claim a complete saved
copy while these continuation records cannot be restored safely.

Saved-copy browsing restores and verifies the complete archive for each request.
Availability batches share one verified access per execution workspace within
the request and allow at most eight remote workspace accesses. Each path still
checks current authority. V1 has no extraction cache across requests. Large saved workspaces can therefore need
substantial transfer time and temporary disk space for each browse request.
Saved Files access admits at most two open extractions per process. It limits an
encrypted archive to 512 MiB, its manifest to 4 MiB, and extraction to 10,000
entries. It reserves at most 2 GiB of temporary space across those accesses and
checks free disk space with a 256 MiB margin. Capacity failures stop before an
object download. Cleanup releases capacity after it removes the owned files.
These limits apply to saved-copy file access. Agent workspace saves and restores
retain their existing archive limits.
Each managed repository preparation also saves a complete workspace archive.
These saves preserve each preparation boundary; V1 does not combine them or use
incremental uploads.

Snapshot retention removes all stored object versions and delete markers before
it records deletion. S3 credentials need `s3:ListBucketVersions` and
`s3:DeleteObjectVersion`, in addition to normal object access. S3-compatible
endpoints must support object-version listing. Permission errors
and object locks retain the cleanup obligation for retry. Other storage deletes
keep their existing behavior unless they explicitly request all versions.

Ordinary sandbox Runner tasks retain the existing API upload restriction:
`call_api` cannot read a workspace file through `files[].path`. Use
`register_deliverable` to register the file, then pass its `artifactId` to
`call_api`. Plugin task providers keep their existing file-read capability.

This feature does not remove the instance volume or qualify HTTP traffic drain,
active provider handoff, or other instance data paths. See
[setup/import](../DEVELOPING.md#experimental-native-remote-workspace-storage) and the
[snapshot storage contract](../DATABASE.md#experimental-remote-workspace-snapshots).

## Company fast-response service

Companies may configure an optional shared API connection and model for short acknowledgements of accepted human turns. Fast responses use direct SDK inference alongside normal agent work, with a three-second admission deadline, bounded prompts/output, current authorization and independent `fast_response` accounting. They are server-marked platform receipts attributed to the agent, never completion, interaction or recovery evidence. Company-sponsored unlinked external senders are explicit; linked-user permission denials are never bypassed. See [fast-responses.md](../fast-responses.md) for provider, delivery, history and endpoint contracts.

Project-derived source removal retains dynamic project access for kept editable
copies and forks. A removed source is absent from Sources and cannot refresh;
ordinary repository attachment does not restart it. Explicit project adoption can
restart tracking without widening the retained content’s access.

Codex execution homes are scoped to the agent’s authorized skill inventory,
including its immutable source versions and an empty inventory. Revocation and
version changes select a separate home and session store while retaining the
selected model account’s credential source. Repository skill auto-update trusts
its upstream authors; operators can pause updates to review changes manually.

### Task collection creation visibility (2026-10-13)

The task Filters menu also offers **Routine tasks**. It selects tasks with
`originKind=routine_execution`, including manually triggered routine runs, even
when other automatic tasks are hidden. The routines list's **View all tasks**
link opens `/issues?view=all&originKind=routine_execution&sortField=created&sortDir=desc` with that checkbox
selected. The URL retains the selection across reloads and task navigation.
Sort controls save `sortField` and `sortDir` in the URL. URL sorting overrides
saved collection sorting, and the routines link opens newest-created tasks first.
Shared sort links retain their order across task interfaces. Workflow sorting
requests the existing authorized dependency-edge projection. Search and board
queries keep their existing server order. Blocked-attention lists reject
`sortField=created` with `422` because they use their own activity order.
Search and pagination apply the routine origin filter on the server. Creation-time
sorting also runs before pagination, with task ID as a stable tie-breaker.

Tasks and project collections default to hiding agent/system-created tasks and
provide a saved **Show agent-created tasks** filter. Classify creation using
creator identity and origin; assignee/responsible users do not imply human
authorship. Routine executions remain automated even when manually triggered.
Creator-less ordinary tasks are system-created. All chat-channel tasks count as
bot-created for this filter, including human-initiated inbound conversations.
Human ordinary and onboarding tasks remain visible. Apply collection creation filters before search limits and
pagination, and retrieve hierarchy context separately under existing access checks.
Context does not count as independent results or board cards. Bounded context
reads retain loaded rows while users reveal more of the tree.

Mine, unread counts, badges, and task toasts use the same personal participation
rules. Automatic creator attribution, synchronized provider comments, manual routine
runs, responsibility, and read-only activity do not admit automatic work. Human
assignment, direct board/API participation, and open addressed requests still qualify.
Only current requests on open tasks qualify. Historical questions remain answerable
without adding tasks to Mine. A request stays unread until the person reads or
replies; automatic task updates do not mark requests as read.
Existing archive behavior and access checks remain in force. Inbox discovery/Blocked preserve
participated automation and hide unrelated automation by default. Agent profile
history, routine history, and task-detail subtasks remain complete. API consumers
that omit the optional creation filter retain their existing list behavior.

Project-derived editable forks retain the project audience present when created.
Later repository attachments do not grant access to those edits. Re-adopting a
removed source uses a separate active tracking identity; retained copies keep
their original provenance. Project membership and visibility remain dynamic.

Automatic skill checks compare tree identity as well as commit identity, so
empty commits do not download or rescan content. Automatic scan work uses a
durable per-source 512 MiB allowance with 512 MiB/hour refill; installed versions
remain usable when it is temporarily limited, and authorized manual Refresh
remains available. Initial imports authorize skills.import before provider work.
At most 20 jobs per project and 100 per company enter the active initial queue;
additional repository bindings remain durable and are admitted automatically
when capacity frees. Project workspace create/update/delete use the existing
workspace-write authorization evaluator. Policy-denied initial jobs await explicit
adoption/repair rather than repeatedly scanning.

Agent-created project sources may reuse only the GitHub connection and grant
already authorized in the persisted active run identity. The responsible person
is recorded for attribution; that identity alone does not permit searching other
personal connections. Without a selected run grant, Sources requires an explicit
human connection repair before background import or update.

Automatic initial repository imports reserve durable company work credits before
provider reads: 512 MiB capacity, refilling 512 MiB per hour, with a 128 MiB
reservation per attempt. Failed downloads and package fallback keep the full
reservation. Successfully linked small imports refund unused measured work.
Completed bindings do not reset company credits; waiting jobs retry on refill.
The company_skill_import_budgets table stores no credentials or source contents.

### Retired Pipelines experiment (2026-10-19)

Pipelines, its review queue and learnings, stage automation, REST API, CLI commands,
and experimental setting are removed. Existing database tables and records remain
for data preservation; there is no migration that drops or rewrites them. The
independent Cases and Routines features remain available.

Company-managed [Prompt Injection Prevention](../prompt-injection-prevention.md)
optionally classifies existing tool-result boundaries through a shared OpenRouter
connection. Settings → Connections is permanent; valid model verdicts take
precedence and dependency failures use the original built-in detector.

### Personal workspace preference

Tasks defaults to All tasks when the viewer has no saved task view. Explicit
view URLs and existing saved task views retain precedence.
Task tables default to Last updated descending without an active sort header;
an explicit column sort selects the header and shows its direction.

Coordinator is the standard workspace for every person. It is not an experiment.
Settings → Experimental offers **Classic workspace**, a personal opt-in that
defaults off. Existing Coordinator experiment values, including historical off
values, do not opt anyone into Classic. The choice is saved per user across
companies on an instance in `user_workspace_preferences.classic_workspace_enabled`;
it is not an instance feature or a company capability. Turning Classic off returns
to Coordinator without modifying canonical tasks, agents, artifacts, permissions,
or runs. Local-trusted development uses the existing shared `local-board` identity,
explicitly identified in Settings. Anonymous and agent actors cannot read or update
this personal choice.

`GET /api/workspace-preferences/me` reads only the caller's choice. For client
compatibility, `coordinatorWorkspaceEnabled` reports the inverse of the Classic
opt-in. The old stored Coordinator column is retained but no longer selects the
workspace. `PUT /api/companies/{companyId}/workspace-preferences/me` saves the
Classic choice through that same inverse property with authorized company audit
context; active viewers may update their own presentation. The preference and
sparse audit event commit atomically. Client caches are keyed by human identity,
and switching waits for successful persistence; unavailable preferences use the
standard Coordinator workspace. This preference does not replace
`enableClassicTaskInterface`.

## Agent connection administration (2026-10-13)

Standard agents can configure connections through the same domain APIs used by the app, bounded by their grants and their responsible user's current authority. Fresh standard agents for default Operators can manage app/tool connections, chat/email channels, AI accounts and pools, profiles and gateways without additional grants. Existing grants are not backfilled; explicit restrictions persist. Gateway administration retains the responsible human's administrative permission and does not grant agents blanket `tools:admin`.

The agent performs authorized setup, reuses saved accounts and drafts, and hands off only required human authentication, consent, credential entry or identity confirmation. Saved handoffs resume through existing task continuation after current authority is rechecked. Management, tool execution and approval remain separate. Private accounts, host commands and stored credentials retain their boundaries; agent-issued gateway clients preserve issuer and responsible-user restrictions at use time.

Authorized policy administration includes user-requested changes that loosen the acting agent’s own tool controls. These writes remain bounded by management grants, resource scope and the responsible user’s current authority; they do not need an additional approval solely because the agent is a target. Subsequent tool calls obey the resulting policy. Agents cannot approve their own governed action requests or edit their own principal permission grants.

The implementation, operation inventory, permission matrix and fixture qualification are recorded in [Agent API parity for connection configuration](../plans/2026-10-13-connection-api-parity.md). Provider fixtures establish API behavior; they do not constitute live provider setup or an empirical agent-success claim.
