# Implementation specification: part 8

## 10.1.1 Organization navigation and Cloud invitations

Core's built-in organization switcher lists this instance's companies. An
installed plugin can replace it through the generic `organizationSwitcher`
slot. The built-in menu remains available when no unique usable contribution
exists. Core does not fetch or render Cloud portfolios in its switcher. Managed
hosts do not expose local company creation in that built-in menu; their extension
owns the creation action.

The Cloud Members-page invitation action still uses the following route:

- `GET /cloud/stacks`

The route exists only on a Cloud-managed instance, requires a trusted
`cloud_tenant` actor, and proxies the current actor's user id plus the current
stack id to the Cloud tenant portfolio endpoint. Client-supplied user ids are
never forwarded. Successful responses are cached briefly per user; self-hosted
instances return `404`.

On Cloud-managed instances, the Members page offers **Invite people** to the
current stack's owner/admin. It opens that stack's Cloud People settings with a
full-page navigation. The destination uses the configured Cloud origin and the
current stack from the authenticated portfolio. The action stays hidden until
that role is known, or when the portfolio request fails. Hiding the tenant-local
Invites tab does not hide this Cloud action.

## 10.2 Goals

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents

The Harness / Runtime configuration page offers **Upgrade runner** for existing
legacy Claude and Codex agents when the target environment selects Paperclip
Runner by default. The action uses the normal authorized agent PATCH with
`runner: "paperclip"`, includes pending configuration edits, and retains the
model and compatible settings. A rejected conversion leaves saved configuration
unchanged and identifies unsupported fields. Successful conversion records a
configuration revision, clears incompatible session state, and preserves agent
identity, instruction files, credentials, run policy, and run history. Existing
agents never upgrade merely by visiting or saving unrelated configuration.

The Core setup wizard creates its agent record when the user submits the agent
name, before adapter selection, authentication, and runtime configuration.
Until the adapter is chosen, the held record uses a provisional adapter
(process with no command when enabled) and `metadata.setupAdapterPending: true`. Resuming such a record
returns to adapter selection with automatic runner selection. Choosing an adapter
updates the same record and clears that marker. Held Copilot records can select
the adapter before connecting an account; account checks still apply at connection
testing and final hire. Setup preserves server-assigned names, including numbered
duplicates. Name-only lookup does not adopt another unfinished record. `POST /companies/:companyId/agents` accepts a board-only `setupId`
(a UUID used as the agent ID). The record stays paused with a `setup` hold;
repeating that request reuses the same unfinished record. It starts no lifecycle
preparation and creates no hire approval. Instructions, task-assignment membership,
and creation activity are applied at final hire. Normal create requests keep their
existing behavior.

The wizard saves configuration on that record through `PATCH /agents/:agentId`.
To finish, it submits the final configuration to
`POST /companies/:companyId/agent-hires` with `setupAgentId`. Core validates the
configuration and completes the same record. Companies that require approval
receive a hire approval for that final configuration; other agents enter normal
preparation and verification. A setup record cannot be resumed into execution,
receive API keys, or authenticate as an agent. Its standard grants apply at hire.
Authorized retries recover the completed record and its existing hire approval;
they cannot replace the submitted configuration. Both setup entry points save
configuration on the record so the roster can reopen it with the same runner.
Resuming setup loads the server configuration before autosaving local edits.
Its saved environment is used for login, connection verification, and final hire.
Changing harnesses drops incompatible saved AI connections. Setup runtime updates
carry the current connection choice rather than retaining a superseded binding.
Connection tests use the setup ID to restore redacted environment values under
the setup creator's permissions; shared connections are installed only at hire.
Changing Claude authentication modes removes the previous mode's credentials.
Held setup records may omit provider details such as the Copilot model; final
hire still requires a complete provider configuration. Kimi API model, protocol,
and endpoint choices are also stored as nonsecret `adapterConfig.kimiApi` settings
so they can be restored while environment values remain redacted.
Credentials remain available for retry when a save response is lost. A confirmed
client rejection removes only newly staged credentials from that attempt.
Sandbox authentication and saved AI connections keep their existing flows.

- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (create API key)
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 Tasks (Issues)

- `GET /companies/:companyId/issues`
- `GET /companies/:companyId/issues/summaries?ids=<uuid>,<uuid>`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `GET /issues/:issueId/access-grants`
- `POST /issues/:issueId/access-grants`
- `POST /issues/:issueId/access-grants/:grantId/revoke`
- `GET /issues/:issueId/documents`
- `GET /issues/:issueId/documents/:key`
- `PUT /issues/:issueId/documents/:key`
- `POST /issues/:issueId/documents/:key/lock`
- `POST /issues/:issueId/documents/:key/unlock`
- `GET /issues/:issueId/documents/:key/revisions`
- `DELETE /issues/:issueId/documents/:key`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/admin/force-release` (board-only lock recovery)
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`
- `GET /issues/:issueId/runner-goal?agentId=...`
- `POST /issues/:issueId/runner-goal/actions`

The runner-goal endpoints control an issue-scoped durable agent-session goal,
not a row in the company `goals` hierarchy. Reads return the effective agent,
negotiated capability, normalized goal snapshot, active-run state, pending
action, and revision. Mutations require a request id, assigned agent, expected
revision, and a negotiated action; they return `202`, replay the original result
for a duplicate request id, and return `409` with the current projection for a
stale revision or an unconfirmed unfinished-goal replacement. These controls do
not create issue comments.

The task-summary endpoint accepts one to five comma-separated UUIDs, normalizes
case and whitespace, and removes duplicates after validating the five-entry
bound. It returns accessible, non-hidden tasks in request order with only ID,
company ID, title, identifier, status, update time, and external-conversation
state. Missing, foreign-company and unauthorized tasks are omitted. Company
access and normal task-read authorization apply; task-bridge keys are denied.
Only the `ids` query parameter is accepted. Malformed, repeated, nested, empty
and oversized ID parameters return `400`, including mixed scalar/nested syntax.
Responses are private and not stored by HTTP caches. Reads do not trigger
full-detail enrichment, workspace inspection or execution recovery.

### 10.4.1 Atomic Checkout Contract

`POST /issues/:issueId/checkout` request:

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

Server behavior:

1. single SQL update with `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`
2. if updated row count is 0, return `409` with current owner/status
3. successful checkout sets `assignee_agent_id`, `status = in_progress`, and `started_at`

`POST /issues/:issueId/release` clears checkout and execution locks. For terminal
issues (`done` or `cancelled`), it preserves the assignee, status, and disposition
timestamps, including on repeated release. For unfinished issues it clears the
agent assignee; only `in_progress` changes to `todo`. Existing company access,
assignee/run ownership checks, and the `issue.released` activity event still apply.

`POST /issues/:issueId/admin/force-release` is an operator recovery endpoint for stale harness locks. It requires board access to the issue company, clears checkout and execution run lock fields, and may clear the agent assignee when `clearAssignee=true` is passed. The route must write an `issue.admin_force_release` activity log entry containing the previous checkout and execution run IDs.

## 10.5 Projects

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`
- `GET /projects/:projectId/access-members`
- `POST /projects/:projectId/access-members`
- `DELETE /projects/:projectId/access-members/:memberId`

Project list, search, direct reads, and nested project routes apply private-project access. Non-members receive the same not-found behavior as missing projects.

## 10.6 Current-user Resource Memberships

- `GET /companies/:companyId/resource-memberships/me`
- `PUT /companies/:companyId/resource-memberships/me/projects/:projectId`
- `PUT /companies/:companyId/resource-memberships/me/agents/:agentId`

Request payload:

```json
{ "state": "joined" }
```

Allowed states are `joined` and `left`. Endpoints require a concrete board user and active company membership, reject agent API keys, and only mutate the caller's own sidebar visibility state. Joining/leaving is idempotent; missing rows read as `joined`.

## 10.7 Approvals

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.8 Cost and Budgets

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.9 Activity and Dashboard

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`
- `GET /companies/:companyId/flow` ([board-only flow report](../company-flow.md))

Dashboard payload must include:

- active/running/paused/error agent counts
- open/in-progress/blocked/done issue counts
- month-to-date spend and budget utilization
- pending approvals count

Dashboard cards show each task once. The server selects distinct tasks from bounded
active and recent run samples before applying the card limit. Active runs take
precedence over completed runs. Taskless runs remain separate cards. The live runs
link counts additional distinct cards and opens the complete list.

## 10.10 Error Semantics

- `400` validation error
- `401` unauthenticated
- `403` unauthorized
- `404` not found
- `409` state conflict (checkout conflict, invalid transition)
- `422` semantic rule violation
- `500` server error

## 10.11 Current Implementation API Addenda

The current app also exposes V1-supporting surfaces for:

- company-scoped summary slots for projects, the workspaces overview, project workspaces, and individual execution workspaces; execution-workspace slots are keyed by execution workspace id so a new workspace never inherits another workspace's summary
- issue thread interactions (`suggest_tasks`, `ask_user_questions`, `request_confirmation`, `request_checkbox_confirmation`, `request_item_verdicts`) with the open-default resolver contract in §9.8.1
- issue approvals, issue references/search, labels, read state, inbox/archive state, and work products
- task search uses shared PostgreSQL matching/ranking for company search and task-list quick search;
  all query terms contribute, quoted phrases stay literal, exact identifiers and direct title matches
  lead relevance ordering, and the UI preserves server result order (see `doc/SEARCH.md`)
- company search through `GET /companies/:companyId/search` plus agent-oriented bulk extraction through
  `GET /companies/:companyId/search/extract`; extraction accepts a server-escaped literal `contains`, optional
  server-owned URL expansion, issue/comment/document scopes, status/date filters, issue-level pagination, a
  bounded `matchesPerIssue` override for machine consumers, and explicit issue/match truncation flags
- execution workspaces, project workspaces, workspace runtime services, and workspace operations. Workspace reads
  derive `deliveryState` as `merged_via_pr | merged_by_ancestry | unmerged | unknown`; terminal issue trees with a
  merged delivery and no active checkout run become cleanup-eligible with reason `issue_terminal` and are archived
  through the workspace cleanup path. Reopening the source issue records activity but does not restore that workspace.
  Before that, terminal isolated worktrees are compacted: ignored, untracked dependency, build, and cache directories
  are removed while the workspace, its branch, and all source changes stay, and reuse regenerates them.
- task watchdog configuration and reusable watchdog issue orchestration for explicitly watched issue subtrees
- routines and scheduled/API/webhook triggers
- plugin installation, configuration, state, jobs, logs, webhooks, and plugin database namespace migration
- company import/export preview/apply, feedback export/vote routes, instance backup/config routes, invites, join requests, memberships, and permission grants
- company skill policy read/replace/reset/simulation, enforced by the same core evaluator used by skill mutation routes
- decision queues and per-attention-item triage:
  - `GET|POST /companies/:companyId/decision-queues`
  - `PATCH /companies/:companyId/decision-queues/:key`
  - `GET|POST /companies/:companyId/decision-queues/:key/items`
  - `DELETE /companies/:companyId/decision-queues/:key/items/:sourceKind/:sourceId`
  - `GET /companies/:companyId/decision-queue-seed-rules`
  - `GET|PUT /companies/:companyId/decision-triage/:sourceKind/:sourceId`
  - `PATCH /companies/:companyId/decision-retention/:sourceKind/:sourceId` (Keep)
  - `POST /companies/:companyId/decision-retention/:sourceKind/:sourceId/archive|revive`
  - `POST /companies/:companyId/decision-archive-proposals`

Queue and triage mutations accept board non-viewers and active standard-scope agents, apply responsible-user intersection for run JWTs, and reject low-trust, `task_bridge`, and `skill_test` contexts. Missing, cross-company, and unauthorized attention sources share the same not-found response.

The attention feed returns server-computed `shelf`, `retentionDays`, `keep`, `archivedAt`, and `retentionVersion` fields. Archived rows are excluded by default and selected with `archived=true`. Bulk archive proposals bind the exact source identities, per-item reasons, activity timestamps, and expected retention versions into the signed decisions-v1 target snapshots; acceptance re-authorizes both proposer and decider and commits all rows or none.

## 11. Heartbeat and Adapter Contract

The fork supports [legacy CLI restart recovery](../restart-session-recovery.md).
Recovery retains the run and provider session when termination and workspace evidence permit a safe resume.
Missing or conflicting evidence retains the reconciliation path.

## 11.1 Adapter Interface

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

### Local adapter engine availability

For the legacy Codex, Claude, Gemini, and Kimi local adapters, an omitted engine
or legacy `auto` value selects ACP deterministically. Missing prerequisites or
ACP execution failures fail the run; they must not launch a different engine
with different session, permission, or sandbox semantics. CLI execution requires
explicit selection. Environment tests report the same engine availability error
as execution. Codex CLI defaults permit workspace writes and network access for
Paperclip coordination without disabling its sandbox; explicit operator
restrictions and execution-target network denials remain effective.

### Experimental personal Muse Runner provider

The `paperclip_runner` adapter can select `provider: "muse"` behind the default-off
Muse and native Runner gates. This connects personal Meta Muse through a
company- and named-agent-bound receiver, distinct from human-authorized MCP.
Pairing, detector contact, and a verified background reply are separate setup
milestones. Idle first-party collaboration retains both agent and authorizing
user permissions; task execution additionally requires the admitted native run.
Only one assignment may execute per connection, and unresolved remote work or
native effects block overlap across cancellation, reconnect, and provider changes.
Remote interruption and external usage remain unconfirmed or unavailable unless
supported by evidence. Release requires the live journeys and bounded cadence
qualification in [Personal Muse receiver](../muse-personal-agent.md).

## 11.2 Process Adapter

Config shape:

```json
{
  "command": "string",
  "args": ["string"],
  "cwd": "string",
  "env": {"KEY": "VALUE"},
  "timeoutSec": 900,
  "graceSec": 15
}
```

Behavior:

- spawn child process
- stream stdout/stderr to run logs
- mark run status on exit code/timeout
- cancel sends SIGTERM then SIGKILL after grace

## 11.3 HTTP Adapter

Config shape:

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

Behavior:

- invoke by outbound HTTP request
- 2xx means accepted
- non-2xx marks failed invocation
- optional callback endpoint allows asynchronous completion updates

## 11.4 Context Delivery

- `thin`: send IDs and pointers only; agent fetches context via API
- `fat`: include current assignments, goal summary, budget snapshot, and recent comments
