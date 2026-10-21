# Implementation specification: part 2

## 7.6 `issues` (core task entity)

Task creation accepts an omitted or blank title when the description contains a prompt.
The server stores the first 120 characters of its whitespace-normalized prompt as
a provisional title and sets `title_needs_generation`. The assigned agent receives
an early instruction to use `set_task_title` (or `PUT /api/issues/:id/title`) to
replace it with a concise title. `onlyIfProvisional: true` atomically preserves a
user or agent title already chosen, including concurrent edits. Explicit title
edits clear the marker. Naming is available in standard, ask, and planning modes;
it does not change status, ownership, or the full description. Title writes are
company-scoped and audited; agent callers must own the active run. Existing tasks
retain their titles and default to no generation request.

- `id` uuid pk
- `company_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `project_workspace_id` uuid fk `project_workspaces.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `visibility` enum-like text: `open | private`, default `open`
- `privacy_root_issue_id` uuid fk `issues.id` null; private-boundary metadata
- `privacy_parent_issue_id` uuid fk `issues.id` null; downward access inheritance, including standalone run-created handoffs
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `review_policy` nullable enum: `anyone | not_creator | human_only`; null is equivalent to `anyone`
- `assignee_agent_id` uuid fk `agents.id` null
- `assignee_user_id` text null
- checkout/execution locks: `checkout_run_id`, `execution_run_id`, `execution_agent_name_key`, `execution_locked_at`
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- identifier fields: `issue_number`, `identifier`
- origin fields: `origin_kind`, `origin_id`, `origin_run_id`, `origin_fingerprint`
- Creation stores the actor run in `origin_run_id` unless an explicit origin run is supplied. `GET /api/companies/:companyId/issues?createdFromIssueId=<uuid>` selects tasks created by runs bound to that source task, using native run issue identity or persisted legacy task context. Historical rows without an origin run may use their recorded creation activity; comments and shared creators do not establish provenance. Source, run, activity and result are company-scoped.
- Delegated follow-ups keep their structural parent. When an agent run bound to an ordinary execution task creates an issue and omits `parentId`, the server defaults `parentId` to that run's task and records `parentDefaultedFromRunIssue: true` on the `issue.created` activity. An explicit `parentId: null` keeps the task standalone. The default never applies to conversation runs (chat handoffs stay top-level), to watchdog follow-ups, to board/user creates, to a run task the agent may not mutate, when the default parent would create a delegation cycle with the requested assignee, or when the agent may not create a child under the default parent (for example a protected assignment policy without a grant); those requests stay standalone instead of failing. An explicitly requested parent is still subject to the ordinary assignment check. Structural parentage, creation provenance and blockers stay distinct: the default adds no blocker.
- `GET /api/issues/:id` returns `createdFrom` (`{ issue: { id, identifier, title, status }, run: { id, agentId }, agent: { id, name } | null } | null`): the task the origin run was executing when it created this issue, resolved from `origin_run_id` or, for historical rows, the run on the recorded creation activity. It is present whether or not `parentId` is set, and only when the viewer may read the source task and its run; a private, hidden-from-viewer or cross-company source yields `null`, indistinguishable from missing provenance.
- Relation lists can use `sortField=id&sortDir=asc&afterId=<uuid>` for stable pagination. The cursor excludes earlier IDs and cannot be combined with an offset or activity-based order.
- The streamlined task page's Tasks tab keeps two independent memberships: the existing subtask tree, and created tasks grouped by their current project (or No project). A created subtask appears in both. Only Subtasks has completion progress; groups collapse independently and unfinished tasks sort above finished tasks.
- `request_depth` int not null default 0
- `work_mode` text not null default `standard`; supported values:
  - `standard`: normal autonomous execution. Agents may investigate, edit files, create artifacts, and complete the task.
  - `ask`: answer-only execution. Agents may use tools for investigation or temporary scratch work, but the deliverable is an issue-thread answer; they must not write implementation code or produce an implementation plan.
  - `planning`: plan-only execution. Agents create or revise the plan without implementation work. Accepting a fresh confirmation for the issue's current `plan` revision atomically changes this mode to `standard`, so the continuation may implement the approved plan on the source issue.
- Work mode is explicit persisted state. Titles, descriptions, and requested deliverables never select or change it. A `standard` task may deliver a requested plan, including a canonical `plan` document, and complete without entering `planning` mode. Existing explicit approval requirements still apply.
- `billing_code` text null
- `assignee_adapter_overrides` jsonb null
- `execution_policy` jsonb null
- `execution_state` jsonb null
- execution workspace fields: `execution_workspace_id`, `execution_workspace_preference`, `execution_workspace_settings`
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null
- `hidden_at` timestamptz null

Invariants:

- single assignee only
- task must trace to company goal chain via `goal_id`, `parent_id`, or project-goal linkage
- `in_progress` requires assignee
- an `in_review -> done | cancelled` verdict is authorized against the current review policy while the issue row is locked; a policy change in the same request or a concurrent request cannot relax that verdict gate
- accepting or rejecting the review-confirmation interaction locks the issue row before resolving the interaction and reauthorizes against the current review policy in that transaction
- accepting a fresh `request_confirmation` for the current issue's `plan` revision changes `work_mode = planning` to `work_mode = standard` in the same transaction as the accepted interaction; the existing agent-return transition also moves an eligible `in_review` issue to `todo` without changing its agent owner
- while a restrictive review policy is stored, changing it requires an actor who is allowed by that row-locked policy
- the transition into `in_review` and its requester activity record commit atomically, including transitions without an explicit review-interaction binding
- terminal states: `done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk not null
- `issue_id` uuid fk `issues.id` not null
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` text not null

## 7.7.1 `issue_access_grants`

- `issue_id` uuid fk `issues.id` not null
- `subject_type` enum-like text: `user | agent`
- `subject_id` text not null
- `source` enum-like text: `explicit | assignment | project`
- `granted_by_user_id` text null
- `granted_by_agent_id` uuid fk `agents.id` null
- `created_at` timestamptz not null
- `revoked_at` timestamptz null

An issue is readable when it is open outside a private project, the actor is an implicit principal (`responsible_user_id`, `created_by_user_id`, `assignee_user_id`, or current `assignee_agent_id`), the actor has an unrevoked grant on the issue or a private ancestor, or the actor is an access member of its private project. This is one canonical predicate shared by detail, list, count, search, and run-derived reads. Instance administrators retain platform-wide access; company owner/admin roles do not imply private-issue read access. Sharing a child covers that child and descendants; ancestors and siblings require separate access. Agent reads also require the responsible user to qualify. A private parent protects existing and newly created descendants; making a parent public does not publish private descendants.

## 7.7.2 `project_access_members`

Authorization membership for private projects, distinct from the personal-sidebar `project_memberships` table:

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `project_id` uuid fk `projects.id` not null
- `subject_type` enum-like text: `user | agent`
- `subject_id` text not null
- `created_at` timestamptz not null
- unique `(project_id, subject_type, subject_id)`

Private projects are absent from list and search results for non-members, and direct reads return `404`. An issue-level grant can still expose its issue without exposing the containing project. A user's `My private tasks` project is created lazily and concurrency-safely on their first unprojected private task; the owning user is its initial and non-removable project member. An agent-created private root also grants that creator issue-level access while retaining the responsible user as the human principal.

## 7.8 `heartbeat_runs`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `issue_id` uuid fk `issues.id` null; first-class binding for issue-scoped run confidentiality
- `invocation_source` enum: `scheduler | manual | callback`
- `status` enum: `queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `external_run_id` text null
- `context_snapshot` jsonb null

## 7.9 `cost_events`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk `agents.id` not null
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` text null
- `provider` text not null
- `model` text not null
- `cost_status` text not null default `reported`; `unpriced` when usage exists but no price was reported
- `input_tokens` int not null default 0
- `output_tokens` int not null default 0
- `cost_cents` int not null
- `occurred_at` timestamptz not null

Invariant: each event must attach to agent and company; rollups are aggregation, never manually edited.

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy | budget_override_required | request_board_approval`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | revision_requested | approved | rejected | cancelled`
- `payload` jsonb not null
- `decision_note` text null
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` timestamptz null

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk not null
- `actor_type` enum: `agent | user | system`
- `actor_id` uuid/text not null
- `action` text not null
- `entity_type` text not null
- `entity_id` uuid/text not null
- `details` jsonb null
- `created_at` timestamptz not null default now()

## 7.12 `project_memberships` + `agent_memberships`

Per-user project/agent membership is personal visibility state for board users. It only controls whether a resource appears in the current user's sidebar; it must not grant or revoke access to all-pages, detail pages, selectors, assignment flows, search, or existing permissions.

`project_memberships`:

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `project_id` uuid fk `projects.id` not null
- `user_id` text not null
- `state` enum-like text: `joined | left`
- `created_at` timestamptz not null default now()
- `updated_at` timestamptz not null default now()
- unique `(company_id, user_id, project_id)`

`agent_memberships` mirrors the same shape with `agent_id` instead of `project_id` and unique `(company_id, user_id, agent_id)`.

Invariants:

- Missing membership rows mean `joined` for backward compatibility.
- Mutations are board-user-only `/me` operations; agent API keys are rejected.
- Viewer-role board users may update only their own membership rows through the narrow self-service helper.
- Target project/agent ownership is checked against the path company before mutation.
- Successful state changes write `resource_membership.joined` or `resource_membership.left` activity entries.

## 7.13 `company_secrets` + `company_secret_versions`

- Secret values are not stored inline in `agents.adapter_config.env`.
- Agent env entries should use secret refs for sensitive values.
- `company_secrets` tracks identity/provider metadata per company.
- `company_secret_versions` stores encrypted/reference material per version.
- Default provider in local deployments: `local_encrypted`.

Operational policy:

- Config read APIs redact sensitive plain values.
- Activity and approval payloads must not persist raw sensitive values.
- Config revisions may include redacted placeholders; such revisions are non-restorable for redacted fields.

## 7.14 Required Indexes

- `agents(company_id, status)`
- `agents(company_id, reports_to)`
- `issues(company_id, status)`
- `issues(company_id, assignee_agent_id, status)`
- `issues(company_id, parent_id)`
- `issues(company_id, project_id)`
- `cost_events(company_id, occurred_at)`
- `cost_events(company_id, agent_id, occurred_at)`
- `heartbeat_runs(company_id, agent_id, started_at desc)`
- `heartbeat_runs(company_id, issue_id, created_at)`
- `approvals(company_id, status, type)`
- `activity_log(company_id, created_at desc)`
- `assets(company_id, created_at desc)`
- `assets(company_id, object_key)` unique
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` unique
- `company_secret_versions(secret_id, version)` unique
- `project_memberships(company_id, user_id)`
- `project_memberships(company_id, user_id, project_id)` unique
- `agent_memberships(company_id, user_id)`
- `agent_memberships(company_id, user_id, agent_id)` unique

## 7.15 `assets` + `issue_attachments`

- `assets` stores provider-backed object metadata (not inline bytes):
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `provider` enum/text (`local_disk | s3`)
  - `object_key` text not null
  - `content_type` text not null
  - `byte_size` bigint not null (safe integer byte count in the API)
  - `sha256` text not null
  - `original_filename` text null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
- `issue_attachments` links assets to issues/comments:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null
- V1 attachment serving contract:
  - Default upload allowlist includes common images, PDF, plain text/markdown/JSON/CSV/HTML, ZIP, and video artifacts (`video/mp4`, `video/webm`, `video/quicktime`).
  - Attachment reads are company-scoped and expose stable path metadata: `contentPath`/`openPath` for inline-safe viewing and `downloadPath` for forced download.
  - Inline-safe responses use `Content-Disposition: inline`; unsafe types and explicit download requests use `attachment`.
  - Script-capable content such as HTML is always served as an attachment with `X-Content-Type-Options: nosniff` and a sandboxed, deny-by-default CSP; it is never rendered inline on the Paperclip origin.
  - The board can fetch bounded HTML source for a rich preview in an opaque-origin iframe (`sandbox="allow-scripts"`, without `allow-same-origin`). A trusted CSP precedes artifact markup and blocks remote subresources, API connections, forms, and embeds. Rendered/raw icons sit beside Download. Workspace HTML previews return UTF-8 inside JSON under the existing text limits. See `doc/html-artifact-previews.md`.
  - Video attachments are inline-safe and support single `Range: bytes=start-end` requests with `206`, `Content-Range`, and `Accept-Ranges: bytes` for browser playback/seeking.
- Attachment-backed artifact work products use `type: "artifact"`, `provider: "paperclip"`, and metadata with `attachmentId`, `contentType`, `byteSize`, `contentPath`, `openPath`, `downloadPath`, and optional `originalFilename`.
- Workspace-only file references use work product `metadata.resourceRef` with `kind: "workspace_file"`, `issueId`, `workspaceKind` (`execution_workspace` or `project_workspace`), `workspaceId`, `relativePath`, optional `line`/`column`, and `displayPath`. These references point at files in a workspace; they do not replace attachment-backed artifacts for deliverables that must be inspectable without workspace access.

## 7.15 `documents` + `document_revisions` + `issue_documents`

- `documents` stores editable text-first documents:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `title` text null
  - `format` text not null (`markdown`)
  - `latest_body` text not null
  - `latest_revision_id` uuid null
  - `latest_revision_number` int not null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
  - `updated_by_agent_id` uuid fk null
  - `updated_by_user_id` uuid/text fk null
  - `locked_at` timestamptz null
  - `locked_by_agent_id` uuid fk null
  - `locked_by_user_id` uuid/text fk null
  - Locked documents are immutable until unlocked. Board operators can lock/unlock; agent writes to a locked key create a new issue document with a derived key instead of overwriting the locked document.
- `document_revisions` stores append-only history:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `document_id` uuid fk not null
  - `revision_number` int not null
  - `body` text not null
  - `change_summary` text null
- `issue_documents` links documents to issues with a stable workflow key:
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `document_id` uuid fk not null
  - `key` text not null (`plan`, `design`, `notes`, etc.)
