# Implementation specification: part 4

## 9.3 Permission Matrix (V1)

| Action | Board | Agent |
|---|---|---|
| Create company | yes | no |
| Hire/create agent | yes (direct) | new standard agents: direct via `canCreateAgents`; low-trust policy or approval gates can restrict |
| Pause/resume agent | yes | pause: no; resume: direct `agents:configure` grant only |
| Create/update task | yes | yes |
| Force reassign task | yes | limited |
| Approve strategy/hire requests | yes | no |
| Report cost | yes | yes |
| Set company budget | yes | no |
| Set subordinate budget | yes | yes (manager subtree only) |
| Manage responsible user's inbox state | yes | yes (default-open policy) |
| Manage another user's inbox state | yes | saved target-user opt-in or scoped `inbox:manage` grant |
| Set work-object visibility (issue/project) | no | no (pro gate) |

Agent resume is the only grant-gated exception in the lifecycle-route group. An
agent actor calling `POST /agents/:agentId/resume` must pass the protected
`agent_config:update` decision with `scope.requiresChangeGrant: true`; self
access does not bypass that decision, and `agents:suggest-changes` alone cannot
apply the lifecycle change. Pause, clear-error, terminate, approval, and
key-management routes remain board-only.

An ordinary standard agent receives a direct `agents:configure` grant on
creation. Existing agents keep their current permissions; no backfill runs.
Low-trust and managed built-in agents do not receive this default. See
[agent permission defaults](../agent-permission-defaults.md) for the full inventory.
Agent-authenticated changes cannot set or restore host-executed process adapter
configuration, including commands and environment values. Agent-authenticated
rollbacks cannot restore host-executed workspace commands either.

### 9.3.1 Shared default-open issue writes

For standard-trust agents, issue comments, issue field/status updates, child
creation under a parent, and assignment share one authorization rule: the
target issue must be visible to the agent and the responsible user represented
by the run must also be authorized. In V1, issue visibility defaults to the
whole company, so these writes are company-wide by default.

The shared rule does not widen low-trust, `skill_test`, or `task_bridge` key
scopes. It also does not replace run-lifecycle controls: checkout ownership,
active-run conflicts, status-transition validation, interaction ownership,
budget gates, and pause gates remain independently enforced. Comment access is
structurally downstream of issue read access (`issue:comment` is a subset of
`issue:read`).

Low-trust agents may create self-assigned tasks and subtasks inside their existing
project or root-task scope. Both creation endpoints enforce task-assignment
authorization, including responsible-user and protected-assignment checks, even
when the new task is unassigned. Created tasks retain the effective containment
policy and quarantined source attribution. Self-assigned decomposition does not
count as delegation back to another agent. Persistent instruction changes remain
restricted except for self-edits requested through authenticated owner chat.
That exception requires the current accepted identity and a recorded direct
board-message wake, and rechecks the user's current instruction-editing permission
when saving. It does not extend to outside work, subtasks, peer instructions, or
other privileged configuration. Denials name the specific restriction.

Authenticated board direction permits a low-trust agent to execute its own
human conversation or the exact task explicitly assigned or addressed by a human.
This server-owned exception is bound to the current assignee and the run's task;
it uses existing conversation identity and authenticated execution-request records,
including same-task retry ancestry. It does not expand inherited boundaries or
grant privileged tools. Backlog assignments retain the existing human requester
without starting a run. Reassignment transactionally cancels prior human requests,
including service/plugin writes; cancelled runs cannot authorize later retries. See `doc/LOW-TRUST-PRESETS.md` for containment details.

Cross-issue writes are contained per heartbeat run. An agent-authored comment
may wake the target assignee, including an explicit `resume: true` comment on a
`done` or `cancelled` issue, but the wake remains agent-class and is subject to
the normal agent rewake throttle; comment presentation cannot give it human
wake privileges. Agent issue comments and updates require a persisted heartbeat
run bound to the authenticated agent and company; missing, invalid, or mismatched
run context fails closed before mutation. A run may attempt at most 20 cross-issue comments, issue
updates, or issue-thread interaction resolutions across one shared counter. The
server records each attempt with its source issue, target issue, run, count, and
rollout mode, and fails closed with the cap in the error once enforcement is
active. Writes to the run's own source issue are not counted. Assignee self-comments do not
wake the assignee, and a non-assignee comment cannot mint a mention grant.

Agent @-mentions are context links only: they do not wake the mentioned agent,
assign work, or forward comments to another task. Normal comment feedback still
routes to the current assignee. Work for another agent requires explicit
assignment, delegation, or a review request.

Agent-authored issue comments persist the responsible user derived from the
authenticated actor; clients cannot choose that attribution. Each comment also
records the write-policy reason, and spoof attempts fail with an audited 422.
Every issue PATCH emits an `issue.updated` activity receipt containing the
actor, responsible user, run, authorization reason, and field-level before/after
changes so both agent and board edits are visible in the issue activity stream.

## 9.4 Permission Terminology and Default Visibility Rule

Paperclip V1 keeps a company-scoped visibility model as the default because centralized authorization and scoped work-object controls are not yet a core V1 control surface.

The approved term set is:

- **Agent profile visibility**: identity-level facts needed for delegation and governance (name, role, capabilities, reporting lines).
- **Agent config visibility**: adapter/runtime config metadata and secret-access policy.
- **Assignment/invocation permission**: who may modify or execute a task.
- **Work-object visibility**: who can read/write issues, comments, projects, and attachments.
- **Tool/secret policy**: what tools and secret-backed credentials an agent can use and what appears in logs.
- **Escalation authority**: where refusal/blocked decisions route (manager, then board).

## 9.5 Core V1 Rule: what “private” means

- A **private marker** on an agent profile (where represented) does **not** make company-visible work private.
- Company-visible work objects (issues, comments, work products, costs, activity, project/task state) remain visible to the board and in-company agents by default.
- Project/issue-level privacy, scoped assignment-only object visibility, and organization-wide custom ACLs are deferred to Pro/Enterprise controls.

## 9.6 V1 vs Pro/Enterprise Controls (recommended target split)

| Permission area | Free / V1 default | Pro / Enterprise |
|---|---|---|
| Company boundary | Hard boundary only (`company_id`) | Multi-company policy overlays (`membership`, `project`, and `task` scopes) |
| Simple roles | Board + agent roles with existing approval/budget gates | Additional role aliases + scoped approver roles |
| Profile visibility | Full profile visibility for coordination and audit | Optional profile redaction / selective sharing for external surfaces |
| Config visibility | Board full read with redacted secret fields; agent config read/write constrained by own agent identity | Scoped config visibility controls and central policy enforcement |
| Assignment/invocation | Assignment creates execution authority; board can reassign or force release | Delegation policies and scoped invokers with deny-listed tool classes |
| Work-object visibility | All issues and projects in-company are visible to board and agents | Project/issue ACLs and reviewer-only channels |
| Tool/secret policy | Secret refs, log redaction, and adapter-level command/webhook restrictions | Tool allowlists with centralized policy evaluation |
| Company skills | Open to authenticated company agents; core enforces invariants and any stored restriction policy | Paperclip EE policy editor, protected-skill controls, presets, simulation, and policy audit UX |
| Inbox management | Responsible agent may archive/unarchive its responsible user's Mine items under a default-open user policy; explicit cross-user access requires saved target-user opt-in or `inbox:manage`; all mutations are audited | Policy administration UX, organization presets, simulations, bulk controls, and richer audit/reporting surfaces |
| Escalation | Escalate from agent to manager to board; board approval/budget gates remain authoritative | Escalation routing and SLA windows |

## 9.7 Recommended first-slice implementation order

1. Lock route-level checks for existing company boundaries, actor extraction, and approval/budget gates.
2. Treat profile privacy as external-facing signal only; do not use it to hide company-visible work objects.
3. Enforce assignment/invocation coupling (`assignee`/`agent` checks, checkout semantics, invocation checks).
4. Standardize read-path redaction for secrets and secret references, including logs and activity.
5. Standardize escalation paths (`blocked` and refusal) so non-board agents hand off by manager/board with immutable audit.
