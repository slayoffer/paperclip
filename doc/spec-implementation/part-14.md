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

Chat connection and destination settings may supply project/workspace defaults. Destination fields override connection fields; omitted values inherit and null clears the inherited choice. Resolve and authorize these defaults once for a new conversation, then retain the resulting task intent. Existing conversations do not change when settings change. Trust confinement still takes precedence.

Agents inspect/select workspaces and request contained repository preparation through ordinary authorized APIs. Repository preparation is idempotent and may require the next admission; it never claims a host-only clone is available in an already-running remote session. Simultaneous tasks may still explicitly share one physical local/SSH folder. Remote sharing requires actual placement and coherent persistence capability.

See [the layer architecture](../plans/2026-10-09-task-workspaces.md) for resolution rules, module ownership, persistence versions, rollout, and verification.

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

Tasks and project collections default to hiding agent/system-created tasks and
provide a saved **show agent-created tasks** filter. Classify creation using
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
