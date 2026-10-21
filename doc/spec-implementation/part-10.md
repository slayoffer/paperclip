# Implementation specification: part 10

## Agent visual identity

Agent appearances are stable, versioned ClipLab end-cap personas, separate from
behavioral instructions. Compact surfaces use on-demand cached PNG URLs; larger
placements may use a lazy live character. See [agent-personas.md](../agent-personas.md)
for persistence, migration, rendering, and integration contracts.
### Experimental task-backed agent chat (2026-09-10)

`enableAgentChat` is an instance experimental flag, default false. Conversation containers remain issues, unique by `(company_id, conversation_agent_id, conversation_user_id)`. The authenticated board actor supplies ownership; local trusted mode uses `local-board`. Ordinary company task access applies. A conversation's agent assignment and identity are immutable through ordinary updates; terminal status mutations are rejected.

`GET /api/companies/:companyId/chats/:agentRef` reads an existing conversation or null. `POST` atomically resolves its issue when adding a chat or on first send/upload. `GET /api/companies/:companyId/chats` lists only the current board user’s conversations in that company, subject to ordinary issue read access. The Chat navigation opens a searchable secondary sidebar with agent avatars and a picker for starting or reopening the same per-agent conversation. Existing issue comment, attachment, document, interaction, and run APIs apply thereafter. User chat comments require an idempotent UUID `clientRequestId`. Conversation delivery preserves comment order through the existing issue execution queue; the durable comment outbox repairs the commit-to-enqueue crash window.

The Chat navigation entry reopens the last agent conversation visited by the current user in the current company. The browser keeps this recent order and any existing conversation ID locally; unavailable agents and removed conversations are skipped. An agent chat that has no issue yet can still reopen from the agent roster. The agent chooser remains the landing view when no saved chat is available.

The server owns conversation state: `waiting` plus `in_review` denotes a healthy idle conversation, and `active` denotes an unanswered or executing turn. Successful replies settle a turn; they do not finish the issue. Idle containers are excluded from execution-work counts, ordinary task lists, timer work, and recovery invocations. Failed/unanswered turns retain normal handling. Child completion never wakes or completes the conversation. Search and direct task access preserve history.

Standalone `/new` is an ordered queue command with no model response. It advances a durable session generation and boundary comment, resets only this issue's provider context, and preserves the issue ID and history. Generation checks reject stale context writes and replies. Fresh replay excludes earlier messages and summaries. The shared transcript renders a session divider.

Chat prompts retain agent instructions and tools while directing clarification and task creation. Substantial execution belongs to linked, assigned ordinary issues. Ask mode remains non-mutating. Feature disablement prevents new turns and resets while retaining data and lifecycle protection; already-running turns may settle normally.

### Agent chat project handoff (2026-09-11)

Chat supports research and full plan drafting/revision in its existing plan document. On handoff, each ordinary assigned task receives the relevant plan in its own `plan` document, committed with task creation before execution is scheduled. The source plan remains in the conversation. Plan acceptance hands off execution; it never switches the conversation into implementation.

Chat instructions require selecting a suitable project, reusing an existing one where appropriate. The project requirement is prompt-only; ordinary projectless tasks remain supported. New parent relationships beneath conversation tasks are rejected by task services, including direct API creation and reparenting. Existing children remain readable/editable and can be moved elsewhere. The Subtasks panel is unchanged.

The `create_project` runtime tool uses the normal project API with durable idempotency. `list_projects` and `list_project_repositories` support selection. Multiple `repositoryIds` select authorized catalog entries; multiple HTTPS GitHub `repositoryUrls` register existing repositories absent from the catalog. IDs and URLs may be combined, but cannot accompany an explicit `workspace`. URLs do not create repositories on GitHub or grant credentials. Execution uses normal repository access rules. Repository IDs are revalidated against the authenticated run's responsible user and connection grants. Agents should consider proper available repositories, clarify material ambiguity, and use repository-free projects when appropriate for non-code work.

Confirmed project creation appears as a durable card in the shared task transcript, including selected repository links. Tasks are linked inline. Failed creation never produces a success card. Tool evals cover planning/handoff, project/repository selection, retries, permission and mode denials, and ordinary delegation regressions using the production chat directive.

### User continuation after execution recovery stops

An authenticated user message, a validated undelivered native message queue, or an exact failed-run Retry can start a fresh
native or legacy conversation turn once the prior execution is confirmed stopped. Retain the source history and uncertain
action outcomes; do not replay tool calls or reset the failed incident's automatic
retry budget. Existing pause, approval, budget, ownership, and dependency gates
remain in effect. See `doc/execution-semantics.md` for admission and stop-proof
requirements.
The task recovery notice offers Retry for eligible failures and verified native
startup cancellations, with failed attempts explained inline. Preparing native
turns keep the Steer label. Steer and Interrupt immediately move the submitted
messages from the composer queue into the conversation while delivery proceeds.
Provider acknowledgement remains authoritative; failed delivery restores the
latest queue with an inline error. Neither action produces a toast.

### Managed AI authentication

AI credentials can be adopted into the existing Connections system. A typed
`runtimeConfig.aiConnection` selects the responsible user’s personal default, an
explicit shared grant. The existing human-audience and agent-access permissions
apply; AI credentials have no separate agent-delegation exception. Selection preserves
harness/model routing and fails closed without ambient credential fallback.
Legacy agents retain their authentication until validated adoption. See
[AI Connections](../connections/AI-CONNECTIONS.md) for company isolation, compatible
methods, lifecycle, runtime enforcement, and migration details.

The selected AI connection supports an on-demand usage probe through the common
connection service, independent of legacy/native execution. The board usage
endpoint rechecks company membership and the credential's human audience before
reading its stored token. Report all returned allowance windows, model/feature
scope, reset times, exhaustion and overage observations; missing values remain
unknown and unsupported methods/provider failures are explicit. The account
detail's Check usage action triggers the probe. No automatic detection, routing,
budget enforcement, credential refresh or credit purchase follows from it.

Provider login failures create a provider-specific Connections card on the task
when the run fails, before generic recovery retries. Reconnect preserves account
identity and permissions. Compatible legacy agents may explicitly adopt a
validated connection inline; late failures must not invalidate newer credentials.

### Task-bound email

AgentMail is a default connection and does not require the experimental chat
setting. It extends the conversation/task pipeline with explicit email publication. Each owned inbox/provider thread binds one task;
external email senders do not gain board authority. Incoming correspondence uses
the assigned agent's normal execution controls. Internal task activity never
implicitly sends email. New outgoing conversations create child tasks and durable
send intents before provider contact. The board directs email work through the
normal task conversation; rich email cards show the correspondence and delivery
outcomes without a separate email composer. See
[AgentMail connections](../connections/AGENTMAIL.md) for setup, transports, recovery,
authorization, and the API/CLI contract.

### Experimental iMessage Photon channel

A Photon Cloud project can represent one agent through the existing
experimental channel subsystem. DMs and explicitly enabled groups create or
continue task-bound conversations. Linked sender identity is the default;
telephone numbers, email addresses, names, and group membership do not grant
Paperclip authority. Photos/files and ordinary questions/confirmations use the
existing attachment, interaction, continuation, and publication contracts.
Pause and Disconnect govern runtime behavior independently of the UI gate.
Local Mac access, unsolicited conversations, and SMS/RCS
fallback are excluded. Live qualification is required before release readiness.
Pro shared allocation supports DMs only, with sender enrollment in Photon and
separate identity linking in Paperclip. Shared channels reserve one project, not
a pool phone number; group admission and publication are disabled. Dedicated
allocation retains one selected number and individually enabled groups.

iMessage task completion ends a turn, not its conversation. Subsequent messages
reopen the same task, including after restart; only explicit `/new` or `/close`
allows the next message to start another task. The open task receives committed
inbound comments live, with “Sent from iMessage” attribution on user bubbles.

See [iMessage Photon](../connections/IMESSAGE-PHOTON.md) for the implementation
contract, setup, recovery, boundaries, and qualification status.

### Native task completion

For ordinary low-risk tasks, accept the current agent's structured `done` claim
subject to explicit workflow constraints. Missing independent evidence or a
`needs_review` label alone must not create a human approval. Require a concrete
reviewer decision for a new review request. Keep unfinished work with the agent,
with bounded continuation and visible recovery. Preserve explicit approvals,
current task ownership, cancellation, dependencies, and newer task state. See
`doc/architecture/native-status-arbitration.md` for finish feedback and the
provenance-checked cleanup of historical automatic completion reviews.

### In-app announcements

A versioned remote JSON manifest supplies one optional board announcement.
The instance validates/caches content, proxies its raster image, and stores
user-scoped dismissals. Closing or following an action dismisses the ID; copy
edits retain it. Writes are board-only, idempotent and transactionally audited
using an authorized company's context. Viewers may dismiss their own card.
This is an explicit exception to company-scoped business entities: the
preference follows one account across companies on the instance. A separate
instance-level registry retains validated publication IDs, allowing offline
dismissal retries after withdrawal while rejecting caller-invented IDs. It
stores no announcement content, account data or interaction events.
See [Announcements](../ANNOUNCEMENTS.md) for API and publishing details.

### Keyboard shortcuts

Keyboard shortcuts are always enabled for every signed-in user. There is no
instance setting and no personal preference that turns them off.

### Persistent managed agent files (2026-09-28)

The Instructions Editor and agent execution share one current agent-owned
directory, scoped by company and agent. The configured instruction entry is one
file in this directory. Registered private copies synchronize supported files
across tasks and sessions, separately from task workspace persistence. Saves
require verified provider stop and current authorization, then synchronize changed
files using per-file last-sync-wins;
new content is not stored as revision history. Existing deployed revisions and
saved execution formats remain compatible during adoption. See
[Persistent agent files](../agent-files.md).

Persistent-file storage limits are advisory for execution: a full folder cannot
pause the agent, fail its run, or prevent later runs. Show a warning on each run
while storage remains full, restore existing files so the agent can remove them,
and enforce the limits on saves. Cleanup clears the warning for future runs.

### Unsafe native workspace exports

An unsafe workspace link does not fail an accepted native task result. Retry
export automatically with confined entries only and keep archive confinement in
place. If the export remains unsafe, omit it and finish the saved result under
normal completion rules. Record diagnostics only in run logs; do not add a task
warning or manual repair action. This also applies to historical unsafe failures:
omit the already-rejected export, clear stale repair notices, and finalize the
accepted result without another provider turn, even when its old sandbox is
unavailable. Preserve current ownership and newer-work fences. See
`native-workspace-finalization-recovery.md`.
