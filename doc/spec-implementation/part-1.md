# Implementation specification: part 1

## 1. Document Role

`SPEC.md` remains the long-horizon product spec.
This document is the concrete, build-ready V1 contract.
When there is a conflict, `SPEC-implementation.md` controls V1 behavior.

The Synthiq fork provides an optional [guarded pull queue](../pull-queue.md).
Task-only [environment selection](../workspace-operations.md#task-environment-selection) precedes defaults and preserves inherited workspace bindings.
`PAPERCLIP_PULL_QUEUE_ENABLED=true` enables event selection, real-work counts, ghost release, and monitor protection.
The default is off. Normal run admission, budget limits, and governance gates remain authoritative.

The Synthiq fork supports [persistent owned task drains](../task-drain.md).
A finite lease blocks admission across server recreation.
Lease release requires the authenticated owner and the matching lease ID.

The fork also supports [saved review waits](../review-waits.md).
An agent can record a board-owned wait for its latest saved review handoff.

## 2. V1 Outcomes

Paperclip V1 must provide a full control-plane loop for autonomous agents:

1. A human board creates a company and defines goals.
2. The board creates and manages agents in an org tree.
3. Agents receive and execute tasks via heartbeat invocations.
4. All work is tracked through tasks/comments with audit visibility.
5. Token/cost usage is reported and budget limits can stop work.
6. The board can intervene anywhere (pause agents/tasks, override decisions).
   An effective task or ancestor pause replaces the message composer with an
   amber Resume takeover. New board messages, including updates with comments,
   are rejected until the hold is released. Drafts survive pause and resume.

Success means one operator can run a small AI-native company end-to-end with clear visibility and control.

## 3. Explicit V1 Product Decisions

These decisions close open questions from `SPEC.md` for V1.

| Topic | V1 Decision |
|---|---|
| Tenancy | Single-tenant deployment, multi-company data model |
| Company model | Company is first-order; all business entities are company-scoped |
| Board | Single human board operator per deployment |
| Org graph | Strict tree (`reports_to` nullable root); no multi-manager reporting |
| Visibility | Issues remain company-open by default. Opt-in `private` issues use task ACLs; deployment exposure flags remain independent of work-object privacy. |
| Communication | Tasks + comments only (no separate chat system) |
| Experimental voice transport | Speko browser voice can create or resume a task through the existing chat-connection delivery/publication pipeline. The selected Paperclip agent retains execution authority. Phone support remains gated on live continuation qualification. |
| Task ownership | Single assignee; atomic checkout required for `in_progress` transition |
| Task watchdogs | A task watchdog is an explicitly configured, issue-subtree-scoped verification and recovery capacity. It may restore live task paths inside the watched subtree; for issue-thread interaction resolution it is an ordinary agent subject to the same audience and containment checks, not board authority, active-run output monitoring, or general liveness recovery. |
| Recovery | Liveness/watchdog recovery preserves explicit ownership: continue interrupted local conversations with bounded fresh turns and preserved history, never replay tool calls automatically; retain native ownership and real execution gates; preserve verified stop evidence and reconsider saved post-stop user messages after cleanup; otherwise open visible source-scoped recovery actions by default, use issue-backed recovery only for independent repair work, or require human escalation (see `doc/execution-semantics.md`) |
| Agent adapters | Built-in `process`, `http`, local CLI/session adapters, and OpenClaw gateway support; external adapters can also be loaded through the adapter plugin flow |
| Plugin framework | Local/self-hosted early plugin runtime is in scope; cloud marketplace and packaged public distribution remain out of scope |
| Auth | Mode-dependent human auth (`local_trusted` implicit board in current code; authenticated mode uses sessions), API keys for agents |
| Budget period | Monthly UTC calendar window |
| Budget enforcement | Soft alerts + hard limit auto-pause |
| Deployment modes | Canonical model is `local_trusted` + `authenticated` with `private/public` exposure policy (see `doc/DEPLOYMENT-MODES.md`) |

Low-trust agent presets are containment controls for hostile automated work, not
general project or issue privacy controls. The core preset resolver contract is
documented in `doc/LOW-TRUST-PRESETS.md`.

## 4. Current Baseline (Repo Snapshot)

As of 2026-02-17, the repo already includes:

- Node + TypeScript backend with REST CRUD for `agents`, `projects`, `goals`, `issues`, `activity`
- React UI pages for dashboard/agents/projects/goals/issues lists
- PostgreSQL schema via Drizzle with embedded PostgreSQL fallback when `DATABASE_URL` is unset

V1 implementation extends this baseline into a company-centric, governance-aware control plane.

## 5. V1 Scope

## 5.1 In Scope

Company administrators may opt in to native Codex and Claude Code logs/traces
through [company agent observability](../agent-observability.md), using a single
company destination and encrypted credentials. This is separate from first-party
Telemetry and infrastructure tracing.


- Company lifecycle (create/list/get/update/archive)
- Goal hierarchy linked to company mission
- Agent lifecycle with org structure and adapter configuration
- Task lifecycle with parent/child hierarchy and comments
- Atomic task checkout and explicit task status transitions
- Board approvals for hires and CEO strategy proposal
- Heartbeat invocation, status tracking, and cancellation
- Cost event ingestion and rollups (agent/task/project/company)
- Budget settings and hard-stop enforcement
- Board web UI for dashboard, org chart, tasks, agents, approvals, costs
- Agent-facing API contract (task read/write, heartbeat report, cost report)
- Auditable activity log for all mutating actions

## 5.2 Out of Scope (V1)

- Cloud-grade plugin marketplace/distribution beyond the local/self-hosted plugin runtime
- Revenue/expense accounting beyond model/token costs
- Knowledge base subsystem
- Public marketplace (ClipHub)
- Multi-board governance (multiple board UIs for a single company)
- Automatic self-healing orchestration (auto-reassign/retry planners)

Role-based human permission granularity is V1 — see the `humans-and-permissions`
plan, the `principal_permission_grants` table, and the `PERMISSION_KEYS` set
in `packages/shared/src/constants.ts`.

## 6. Architecture

### Experimental persistent cases and handoffs

Standalone cases (`enableCases`) are independent of the experimental pipeline
case model. A passive case has no execution requirement. `work_issue_id` binds at
most one primary ordinary task per case and one primary case per task. Handoffs
reuse that task, update its assignee through normal task policy, and store a free
text phase separately from case/task status. They do not satisfy review gates.

Native `create_case` requires `kickoff` and exactly one of `workflowId` or
`workflow_document_text`, delegating to ordinary case handoff acceptance.
New-case API handoffs accept the same choice. The selected prompt is saved verbatim as ordinary task document key `workflow`, title
`Workflow`, format `markdown`. Missing or blank text is rejected before mutation.
Top-level `initialDocuments` belongs to first-task kickoff: normalized, unique
task document keys, at most 20 additional documents and 200,000 total body
characters including the workflow. Its key is reserved from additional seeds.
The acceptance transaction writes
ordinary task documents, attribution and activity before durable wake delivery.
Retries share the kickoff receipt and cannot repeat document revisions. Existing
primary tasks, binding existing tasks and terminal handoffs reject initial
documents. There is no passive native creation branch or document seed storage. Native case-document
tools are retired; case detail and execution context roll up authorized task
document references, omitting bodies and system keys. Historical case document
storage and REST reads remain compatible.

Starting the first new task of an existing passive case also requires a workflow
ID or inline workflow text. New-case binding may create `workflow` on the bound task with ordinary task
mutation authority and create-only revision semantics; an existing key conflicts
atomically. Later handoffs of an existing primary task omit workflow text and
revise it through ordinary task document tools. Existing stored cases are not
backfilled. Receiving agents are instructed to read the task's workflow document;
its authorized metadata precedes the document reference budget, while its body
is read on demand. Recommend both a Mermaid `stateDiagram-v2` map and prose
defining each transition's trigger, evidence, destination agent, human wait/resume
rules, and correction/escalation limits. State IDs match phases and named edge
outcomes are defined in prose. No graph parser, guard interpreter or new workflow
execution service is added.

Reusable `workflows` are company-scoped definitions with a name, Markdown prompt,
and ordinary attribution/timestamps. Cases hold an optional `workflowId`; their
case type, facts, status and free-text phase remain independent. There are no
workflow versions, workflow runs, state graphs, or role bindings. The task's
`workflow` document is the effective procedure and owns its revision history.
Editing a shared definition affects future adoptions only.

Agent handoffs omit `workflowId` to preserve the relationship and document,
supply an ID to adopt the latest prompt (including the current ID to refresh),
or supply null to detach while retaining instructions. Acceptance snapshots the
selected prompt, previous/next workflow IDs, names and phases, and the document's
base revision. Transfer applies the relationship, phase and effective document
revision in one transaction after outgoing execution settles. Intervening
changes to the workflow document hold adoption with the existing revision
conflict; cancel and submit new intent after reading current state. Cancelled,
unapplied intent changes neither instructions nor workflow routing. Applied
retries never create another document revision. Generic case updates cannot
change workflow routing. Historical handoffs remain readable without inferred
workflow assignments, and repeated visits are distinct handoffs. Captured names
survive renames. Terminal completion semantics are unchanged.

Company list/create and individual read/update workflow endpoints, plus native
`list_workflows`, `read_workflow`, `create_workflow` and `update_workflow`, share
`experimental.enableCases`. Lists and mutation receipts return metadata; prompt
reads are on demand, using bounded native API JSON text pages. The existing
company authorization, source-trust and run mutation fences apply. Definitions
are company-shared; no case document is automatically published into them.
Existing case pages and Audit show current and captured workflow names/phases,
distinguishing pending intent from applied transitions. Authoring is API/agent
first; there is no workflow editor or deletion lifecycle.

`case_handoffs` is a durable, principal-idempotent intent/delivery ledger.
Acceptance atomically stores the comment, links, observed revisions, audit, and
delivery identity. A running source yields; it retains execution ownership until
provider termination and workspace/session settlement are proven. Its late
mutations cannot complete transferred work. Delivery uses the ordinary wake queue
with a stable receipt, preserving Stop, private access, responsible-user, pause,
and budget rules. A queued receipt is not proof that the recipient ran.
Whole-company deletion removes cases and their history before tasks and agents.
Permanent deletion of an individual agent with retained handoff history returns
`409 agent_case_history_retained`; keep that agent terminated to preserve attribution.

An existing case with a primary task may instead receive `to: "done"`.
This terminal handoff records `awaiting_completion`, keeps assignment and
execution unchanged, and returns `callerMustYield: false`. Normal task
completion remains authoritative: accepted transition to `done` atomically
closes the case, sets its phase to `done` and records the handoff as `completed`.
A task already done settles immediately. Reviews, questions and other legitimate
waits do not close the case. Stop, task cancellation and reassignment cancel
the intent. Recording a terminal intent cannot manufacture completion evidence
or bypass review. Ordinary task completion without this intent leaves case
status unchanged. Settling an admitted intent remains available while cases
are disabled, like outgoing-execution cleanup.

`case_access_sources` retains existing task/project boundaries. All sources must
remain readable; unlinking or deletion cannot widen access. The same policy covers
case contents, documents, revisions, annotations, assets, history, audit, and live
publication. Agents cannot supply creator or responsible-user overrides.

The REST operation is `POST /api/companies/:companyId/case-handoffs`; native agents
use `handoff_case`. History, retry, and cancel stay on the case. Workflow routing
lives in prompts/skills, without a server-configured phase graph. See
[persistent case handoffs](../plans/2026-10-19-persistent-case-handoffs.md).

Native standard-mode agents also have `create_case`, `read_case` and
`update_case`. Reads and updates default to the task's primary case and preserve
the standalone-case authorization, provenance and audit rules of REST. Case
updates expose facts only; routing, status and permissions remain outside those
updates. Update receipts deduplicate identical keys within one admitted run;
creation and handoff receipts remain principal-scoped. Ordinary `read_document`
and `write_document` manage the active task's revisioned documents.

`read_case` keeps small responses structured. Large responses return bounded
`readPage.text` JSON chunks with case/task routing versions on every page. Use
`section: "fields"` to retrieve the entire fields object, including large keys,
strings, and arrays. Continue with the same `section` and `snapshot`, passing
`offsetBytes: readPage.nextOffsetBytes` until it is null; concatenate the text
before parsing JSON. A 409 means facts, accessible references, or routing changed:
restart at offset zero without the old snapshot. Each page reauthorizes current case access through
`GET /api/cases/:id?agentRead=true`; no generic API tool or asset grant is needed.
`limitBytes` is 4–8192 UTF-8 bytes. Ordinary REST reads retain their existing full
response, and ordinary `update_case` mutation receipts remain unchanged.
For `section: "document"`, require `documentKey` and optionally
`documentIssueId`. Omit the task ID for historical case-owned documents; a
supplied ID must identify the case's primary or currently linked task. Return
the selected document as bounded JSON pages. Recheck source access, linkage,
and document trust on every page, and reject system or quarantined documents.
Document identity, revision and body participate in the snapshot. These reads
work without generic API tools and confer no additional mutation authority.

Case context is authorized on each admission. Fresh sessions receive a bounded
snapshot; verified native continuations send current routing metadata and new
handoff instructions, plus case facts when their content or document revisions
change. An incompatible or unproven prior projection falls back to full context.
This limits repeated input without treating prepared database snapshots as proof
that a provider received them.

The existing Cases navigation opens read-only list and detail pages. List filters
are URL-backed and applied before authorized pagination. A distinct-types read
uses the same case visibility policy. Rows include batched current work context;
detail preserves document previews/revisions, attachments, references, activity
and handoff history. No case mutation or handoff recovery controls appear there.

## 6.1 Runtime Components

- `server/`: REST API, auth, orchestration services
- `ui/`: Board operator interface
- `packages/db/`: Drizzle schema, migrations, DB clients (Postgres)
- `packages/shared/`: Shared API types, validators, constants

## 6.2 Data Stores

- Primary: PostgreSQL
- Local default: embedded PostgreSQL at `~/.paperclip/instances/default/db`
- Optional local prod-like: Docker Postgres
- Optional hosted: Supabase/Postgres-compatible
- File/object storage:
  - local default: `~/.paperclip/instances/default/data/storage` (`local_disk`)
  - cloud: S3-compatible object storage (`s3`)

## 6.3 Background Processing

A lightweight scheduler/worker in the server process handles:

- heartbeat trigger checks
- stuck run detection
- budget threshold checks

Separate queue infrastructure is not required for V1.

## 7. Canonical Data Model (V1)

All core tables include `id`, `created_at`, `updated_at` unless noted.

## 7.0 Auth Tables

Human auth tables (`users`, `sessions`, and provider-specific auth artifacts) are managed by the selected auth library. This spec treats them as required dependencies and references `users.id` where user attribution is needed.

## 7.1 `companies`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`
- `pause_reason` text null
- `paused_at` timestamptz null
- `issue_prefix` text not null
- `issue_counter` int not null
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `require_board_approval_for_new_agents` boolean not null default false
- feedback sharing consent fields

Invariant: every business record belongs to exactly one company.

## 7.2 `agents`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `icon` text null
- `status` enum: `active | paused | idle | running | error | pending_approval | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` text; built-ins include `process`, `http`, `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `pi_local`, `cursor`, `hermes_local`, `hermes_gateway`, and `openclaw_gateway`
- `adapter_config` jsonb not null
- `runtime_config` jsonb not null default `{}`; contains Paperclip runtime policy such as heartbeat scheduling and debug settings
- `default_environment_id` uuid fk `environments.id` null
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- pause fields: `pause_reason`, `paused_at`
- `permissions` jsonb not null default `{}`
- `last_heartbeat_at` timestamptz null
- `metadata` jsonb null
- `created_by_user_id` text null; the human user who created or requested the agent. Null for agent-requested and system-created agents. The agent overview shows it only when the company has more than one human member; the local Board principal is never counted or shown.

Invariants:

- agent and manager must be in same company
- no cycles in reporting tree
- `terminated` agents cannot be resumed
