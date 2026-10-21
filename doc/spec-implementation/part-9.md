# Implementation specification: part 9

## 11.7 Durable agent session goals

Runner Protocol v2 negotiates a required `sessionGoals` capability and typed
`session.goal.*` commands and events. PRP v1 sessions remain supported and are
goal unsupported. The Codex app-server driver maps controls to
`thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; it observes
provider-created goal notifications and reconciles with an authoritative get
after each turn. An active goal suppresses premature run terminalization while
autonomous turns continue. The Paperclip runner's persistent ACP backend opts
in through the `_session/goal` extension and advertises its exact action subset.
Its pinned Codex/Claude executables retain the runner's Linux x64 qualification
requirement. Direct `codex_local` and `claude_local` adapters currently have no
live goal controller and remain unsupported, even when their underlying ACP
package exposes goals. Goal actions never change an agent's adapter, model,
permission policy, or rollout settings to manufacture support. CLI, one-shot
ACP, and providers without the structured extension remain unsupported.

When a goal heartbeat settles, the runner suspends its durable authority even
under a warm lifecycle policy. Paused, blocked, completed, and rollover goals
must survive controller restart without relying on an in-memory warm owner.
The next run resumes the same provider session through the existing verified
checkpoint and authority-rotation path.

The board composer treats `/goal` as an action command rather than Markdown or
comment text. It is capability-aware, and the issue thread renders durable goal
status and controls immediately above the composer. Goal completion enters the
normal run-result/completion arbitration path and does not directly close the
issue.

## 12. Governance and Approval Flows

## 12.1 Hiring

1. Agent or board creates `approval(type=hire_agent, status=pending, payload=agent draft)`.
2. Board approves or rejects.
3. On approval, server creates agent row and initial API key (optional).
4. Decision is logged in `activity_log`.

Board can bypass request flow and create agents directly via UI; direct create is still logged as a governance action.

## 12.2 CEO Strategy Approval

1. CEO posts strategy proposal as `approval(type=approve_ceo_strategy)`.
2. Board reviews payload (plan text, initial structure, high-level tasks).
3. Approval unlocks execution state for CEO-created delegated work.

Before first strategy approval, CEO may only draft tasks, not transition them to active execution states.

## 12.3 Board Override

Board can at any time:

- pause/resume/terminate any agent
- reassign or cancel any task
- edit budgets and limits
- approve/reject/cancel pending approvals

## 12.4 Connection Tool Reviews

Ask-first connection calls use a server-owned tool-action confirmation linked to
the authoritative action request. The task feed retains a stable record; dismissal
only hides the pending card above the composer. The ordinary composer remains
available while the card is open. Task and Connections decisions share one
transaction. Approval runs stored, signed arguments once; decline runs nothing.
The human decision remains distinct from provider execution success or failure.

Always allow remembers the same agent, connection, and action, restricted to the
current project when present, with future argument values permitted. Explicit
denials, revoked access, catalog-definition changes, and formal approval gates
remain effective. A durable continuation receipt resumes eligible task context
with the recorded outcome after the agent yields. Uncertain interrupted execution
is surfaced without automatic replay. See [Task reviews](../connections/TASK-REVIEWS.md)
for contracts, recovery behavior, Storybook, and acceptance workflows.

## 13. Cost and Budget System

## 13.1 Budget Layers

- company monthly budget
- agent monthly budget
- optional project budget (if configured)

## 13.2 Enforcement Rules

- soft alert default threshold: 80%
- hard limit: at 100%, trigger:
  - set agent status to `paused`
  - block new checkout/invocation for that agent
  - emit high-priority activity event

Board may override by raising budget or explicitly resuming agent.

Native runs retain final usage receipts during a bounded accounting-only drain
after a governed wait cancels provider work. This does not accept late messages,
tool calls, or new completion proposals. Missing or incomplete receipts continue
to block budget admission.
A controller that detaches for server restart loses checkpoint and completion
write authority. A closing event stream is not proof that the governed run
finished; the replacement controller must adopt and settle the original run.

Complete direct Anthropic API receipts for `claude-sonnet-5` can use a versioned
list-price estimate when the provider supplies no run price. The receipt records
the rates and assumptions. Aggregate cache writes use the one-hour rate because
their TTL is unknown. Estimates are not invoices. Other models, billers, unknown
billing types, and incomplete receipts remain unpriced.

## 13.3 Cost Event Ingestion

`POST /companies/:companyId/cost-events` body:

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

Validation:

- non-negative token counts
- `costCents >= 0`
- company ownership checks for all linked entities

## 13.4 Rollups

Read-time aggregate queries are acceptable for V1.
Materialized rollups can be added later if query latency exceeds targets.

The Costs overview distinguishes unknown billing categories, missing model/price
data, and terminal runs awaiting final receipts. Bounded, company-scoped details
load on demand at `GET /companies/:companyId/costs/data-quality`. Entries link to
the run and, where applicable, agent configuration for future usage. Normal
credits and fixed billing are not unknown billing warnings. Unavailable historic
prices require no cleanup and must not be presented as zero-cost receipts.

`POST /companies/:companyId/costs/retry-accounting` accepts a run ID, requires a
board cost reader with a non-viewer membership, and uses the existing audited,
idempotent accounting service. It never executes an agent. The UI offers retry
only when the saved run is eligible to record costs. Missing final usage changes
its display label after fifteen minutes; elapsed time never settles the debt or
discards a late receipt. Raw provider errors and credentials are excluded from
cost details. ACP usage retains the runtime-selected model, including defaults;
conflicting before/after model IDs do not authorize a single-model estimate.
Remote OpenCode billing uses only credentials forwarded to the execution target.
Cost detail reads use company-scoped partial indexes matching their filters and
sort order. Provider and biller cards retain estimate and missing-price labels;
an accounting retry confirmation survives removal of the resolved cost gap.

## 14. UI Requirements (Board App)

V1 UI routes:

- `/` dashboard
- `/companies` company list/create
- `/companies/:id/org` org chart and agent status
- `/companies/:id/tasks` task list/kanban
- `/companies/:id/agents/:agentId` agent detail
- `/companies/:id/costs` cost and budget dashboard
- `/companies/:id/approvals` pending/history approvals
- `/companies/:id/activity` audit/event stream

Required UX behaviors:

- global company selector
- quick actions: pause/resume agent, create task, approve/reject request
- conflict toasts on atomic checkout failure
- no silent background failures; every failed run visible in UI

Regular task chats and Agent Chat keep unanswered questions as compact,
reopenable entries at their original position in the feed. Dismissing a question
or sending a newer message clears its form from the composer without resolving
the saved question. Questions do not contribute to composer pending counts.
Dismissal persists locally for the person and task across reloads; reopening
restores the original form and draft. Approval and permission gates are unchanged.

A saved ordinary question becomes historical when a newer human task message
moves it out of the current composer. Agent context, completion feedback, and
native finalization apply the same rule. The historical question remains pending
and answerable, including after completion; a later human answer records history
without reopening the task or waking its agent. Its presence alone does not
request another answer or prevent completion. Cancellation still expires pending
questions. Agents continue work that does not need the missing input and withdraw
obsolete questions when later evidence satisfies them. A real current input
blocker must identify what is still needed. Approval, permission, connection,
and configured review gates remain active. No server-side UI dismissal record
is required.

## 15. Operational Requirements

## 15.1 Environment

- Node 24.11+
- `DATABASE_URL` optional
- if unset, auto-use embedded PostgreSQL under `~/.paperclip/instances/default/db`

## 15.2 Migrations

- Drizzle migrations are source of truth
- local/dev startup applies pending migrations automatically where supported
- `pnpm db:migrate` applies pending migrations manually
- no destructive migration in-place for V1 upgrade path

## 15.3 Logging and Audit

- structured logs (JSON in production)
- request ID per API call
- every mutation writes `activity_log`

## 15.4 Reliability Targets

The offline publication authority source stores immutable, company-scoped requests
and single-use dispatch decisions. It serializes decisions with current issue,
run, agent, company, repository, and revocation records through PostgreSQL row locks.
It exposes no production route or listener. Existing publication approval rules
remain effective. See [Offline publication authority](../publication-authority.md).

- API p95 latency under 250 ms for standard CRUD at 1k tasks/company
- heartbeat invoke acknowledgement under 2 s for process adapter
- no lost approval decisions (transactional writes)

## 16. Security Requirements

- store only hashed agent API keys
- redact secrets in logs (`adapter_config`, auth headers, env vars)
- forward authorized semantic tool arguments unchanged, including credential-bearing document and instruction content; the provider harness owns credential-content policy, and diagnostic redaction must not act as a save or execution gate
- CSRF protection for board session endpoints
- rate limit auth and key-management endpoints
- strict company boundary checks on every entity fetch/mutation
- restricted `skill_test` and `task_bridge` keys cannot enumerate company-wide run telemetry, workspace-operation logs, or the company secret catalog
- HTTP adapters use DNS-pinned outbound requests, reject redirects and link-local/metadata targets, and require an exact server-owner origin allowlist for private destinations
- external instruction bundle roots and exports that read them require instance-admin access; managed company-scoped bundles remain available through normal company authorization
- agent-authenticated callers cannot persist host-executed workspace commands, and restricted keys cannot invoke preconfigured workspace runtime controls

## 17. Testing Strategy

## 17.1 Unit Tests

- state transition guards (agent, issue, approval)
- budget enforcement rules
- adapter invocation/cancel semantics

## 17.2 Integration Tests

- atomic checkout conflict behavior
- approval-to-agent creation flow
- cost ingestion and rollup correctness
- pause while run is active (graceful cancel then force kill)

## 17.3 End-to-End Tests

- board creates company -> hires CEO -> approves strategy -> CEO receives work
- agent reports cost -> budget threshold reached -> auto-pause occurs
- task delegation across teams with request depth increment

## 17.4 Regression Suite Minimum

A release candidate is blocked unless these pass:

1. auth boundary tests
2. checkout race test
3. hard budget stop test
4. agent pause/resume test
5. dashboard summary consistency test

## 18. Delivery Plan

Current implementation note: the milestones below describe the original V1 sequencing. Several systems originally framed as future work have since shipped or advanced materially, including issue documents/interactions, blockers, routines, execution workspaces, import/export portability, authenticated deployment modes, multi-user basics, and the local/self-hosted plugin runtime.

## Milestone 1: Company Core and Auth

- add `companies` and company scoping to existing entities
- add board session auth and agent API keys
- migrate existing API routes to company-aware paths

## Milestone 2: Task and Governance Semantics

- implement atomic checkout endpoint
- implement issue comments and lifecycle guards
- implement approvals table and hire/strategy workflows

## Milestone 3: Heartbeat and Adapter Runtime

- implement adapter interface
- ship `process` adapter with cancel semantics
- ship `http` adapter with timeout/error handling
- persist heartbeat runs and statuses

## Milestone 4: Cost and Budget Controls

- implement cost events ingestion
- implement monthly rollups and dashboards
- enforce hard limit auto-pause

## Milestone 5: Board UI Completion

- add company selector and org chart view
- add approvals and cost pages

## Milestone 6: Hardening and Release

- full integration/e2e suite
- seed/demo company templates for local testing
- release checklist and docs update

## 19. Acceptance Criteria (Release Gate)

V1 is complete only when all criteria are true:

1. A board user can create multiple companies and switch between them.
2. A company can run at least one active heartbeat-enabled agent.
3. Task checkout is conflict-safe with `409` on concurrent claims.
4. Agents can update tasks/comments and report costs with API keys only.
5. Board can approve/reject hire and CEO strategy requests in UI.
6. Budget hard limit auto-pauses an agent and prevents new invocations.
7. Dashboard shows accurate counts/spend from live DB data.
8. Every mutation is auditable in activity log.
9. App runs with embedded PostgreSQL by default and with external Postgres via `DATABASE_URL`.

## 20. Post-V1 Backlog (Explicitly Deferred)

- cloud-grade plugin marketplace/distribution
- richer workflow-state customization per team
- milestones/labels/dependency graph depth beyond V1 minimum
- realtime transport optimization (SSE/WebSockets)
- public template marketplace integration (ClipHub)

## 21. Company Portability Package (V1 Addendum)

V1 supports company import/export using a portable package contract:

- markdown-first package rooted at `COMPANY.md`
- implicit folder discovery by convention
- `.paperclip.yaml` sidecar for Paperclip-specific fidelity
- canonical base package is vendor-neutral and aligned with `docs/companies/companies-spec.md`
- common conventions:
  - `agents/<slug>/AGENTS.md`
  - `teams/<slug>/TEAM.md`
  - `projects/<slug>/PROJECT.md`
  - `projects/<slug>/tasks/<slug>/TASK.md`
  - `tasks/<slug>/TASK.md`
  - `skills/<slug>/SKILL.md`

Export/import behavior in V1:

- export emits a clean vendor-neutral markdown package plus `.paperclip.yaml`
- projects and starter tasks are opt-in export content rather than default package content
- recurring `TASK.md` entries use `recurring: true` in the base package and Paperclip routine fidelity in `.paperclip.yaml`
- Paperclip imports recurring task packages as routines instead of downgrading them to one-time issues
- export strips environment-specific paths (`cwd`, local instruction file paths, inline prompt duplication) while preserving portable project repo/workspace metadata such as `repoUrl`, refs, and workspace-policy references keyed in `.paperclip.yaml`
- export never includes secret values; env inputs are reported as portable declarations instead
- export preserves explicit company skill policy and retained legacy skill grants in `.paperclip.yaml`; absence of policy remains the open default
- import supports target modes:
  - create a new company
  - import into an existing company
- import recreates exported project workspaces and remaps portable workspace keys back to target-local workspace ids
- import forces imported agent timer heartbeats off so packages never start scheduled runs implicitly
- import supports collision strategies: `rename`, `skip`, `replace`
- import supports preview (dry-run) before apply
- import preview reports skill-policy and legacy-grant mappings before apply and rejects unknown policy schema versions
- GitHub imports warn on unpinned refs instead of blocking
