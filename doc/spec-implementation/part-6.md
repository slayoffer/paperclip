# Implementation specification: part 6

## 9.9 Task Watchdog Authority Contract

A task watchdog is a scoped execution capacity for a configured watchdog agent on one watched issue subtree. It is not a separate principal, does not inherit board auth, and does not expand the selected agent's company boundary. The server must enforce the watchdog contract from persisted watchdog configuration and run context; custom instructions and prompt text can narrow the mandate but cannot expand it.

The watched subtree is the source issue plus descendants reached through `parent_id`, excluding every issue whose `origin_kind = 'task_watchdog'` and excluding all descendants below those watchdog issues. The generated reusable watchdog issue is outside the watched work subtree for scan purposes, but the watchdog agent may update that reusable watchdog issue to record its own review disposition.

Task-watchdog wakes must include server-derived capability metadata that names the watched root, reusable watchdog issue, excluded `task_watchdog` origin branches, allowed operations, and denied operations. Watchdogs must use that metadata and server denials for capability discovery; they must not create visible probe issues, comments, or throwaway tasks to learn their permissions.

### Allowed watchdog mutations

Within the watched subtree, a watchdog run may perform only mutations that restore or clarify the next live/waiting path:

- add comments that explain findings, evidence, and next action
- create descendant follow-up issues under an included subtree issue, inheriting company, project, goal, and workspace context from that subtree
- assign or reassign included issues to active, invokable, same-company agents when normal assignment checks and scoped assignment grants allow it
- move included issues among `todo`, `in_progress`, `in_review`, and `blocked` when the transition is needed to restore a valid action path
- reopen `done` or `cancelled` included issues only with explicit resume metadata and an audit comment when evidence shows the stopped disposition is wrong or incomplete
- add, replace, or clear blockers on included issues when the blocker target is in the same company and the change makes the waiting path more accurate
- set or refresh a one-shot monitor on an included issue when the current assignee owns the future check
- resolve issue-thread interactions through the ordinary resolver-audience path
  when the watchdog agent otherwise has issue access and the effective policy allows it
- update the reusable watchdog issue itself to `done`, `in_review`, or `blocked` with the evidence for the watchdog decision

Every watchdog-triggered mutation must write activity with the watchdog id, source issue id, watchdog issue id when present, run id, and stop fingerprint. Mutations still use the normal status-transition, blocker, assignment, budget, and company-boundary guards.

### Atomic recovery batch

A watchdog run may submit an atomic recovery batch of at most 3 mutations drawn from the allowed-mutation list above, validated against the stop fingerprint that run observed. The server applies the batch all-or-nothing: if the subtree's stop fingerprint changed between observation and application — the subtree went live concurrently — the entire remainder of the batch is aborted and the staleness is recorded as evidence on the reusable watchdog issue. The batch is single-shot per watchdog run. This replaces the exactly-one-fresh-write model: the stale-guard's purpose (never mutate a subtree that concurrently went live) is preserved by fingerprint validation on the whole batch rather than by capping the run at one write, so a restoration that needs both a state-restoring `PATCH` and an explanatory comment cannot forfeit the restoration by ordering the comment first.

### Restoration verification and escalation

Reviewed-fingerprint suppression is disposition-aware. A watchdog disposition of "stopped state is legitimate" suppresses re-fire for that fingerprint as today. A disposition of "live path restored" arms a bounded verification instead:

- if a later scan observes the subtree stopped with a fingerprint equal to the one the restoration claimed to fix, the watchdog re-fires with an incremented attempt count for that fingerprint lineage
- restoration-attempt lineage (attempt number, claimed-fixed fingerprint, restoration actions) is persisted durable watchdog state
- the stop fingerprint (or the lineage check) must account for intermediate-node durable updates so a restoration that changes no stopped leaf is classified as a failed restoration, not as a reviewed stop
- after N attempts (N = 2–3, configuration-bounded) on the same fingerprint lineage, the platform stops re-firing and escalates to a human — the watchdog owner or a board notification — with the attempt history attached

Escalation is terminal for the automatic loop: no further watchdog wakes fire for that lineage until a human or a new durable subtree change produces a different fingerprint.

### Disallowed watchdog mutations

A task watchdog must not:

- mutate issues outside the watched subtree, except for comments or newly created follow-up issues that are children of included subtree issues
- mutate company, project, goal, agent, auth, API key, budget, secret, environment, plugin, or deployment settings
- approve or reject rows in the `approvals` table, including hiring, CEO strategy, spend, budget override, or `request_board_approval` decisions
- resolve execution-policy decisions unless the watchdog agent is the typed participant under that policy outside of its watchdog capacity
- force-release checkout/execution locks, cancel active runs, terminate processes, or perform active-run output watchdog decisions
- create visible probe issues, comments, or throwaway tasks to discover whether an operation is allowed
- delete issue documents, comments, attachments, work products, or activity records
- change the watchdog configuration, select a different watchdog agent, or create nested watchdog configurations
- treat custom instructions as authority to bypass approval gates, cross company boundaries, access secrets, or override this contract

When the safe next action needs one of these disallowed mutations, the watchdog must leave a valid waiting path by commenting, creating an in-subtree escalation/follow-up issue, assigning to the correct owner, or leaving the source issue blocked on a first-class blocker.

### Interaction resolution

A task-watchdog run has no special resolver audience, plan-purpose marker, or
interaction-kind allowlist. The task-watchdog context neither widens nor
categorically removes the selected agent's ordinary interaction authority. The
same evaluator used for every agent applies `anyone`, `not_creator`, `human_only`,
named-addressee, company-cap, company-boundary, run-attribution, low-trust,
task-bridge, target-staleness, and exact-once checks.

Resolving an interaction does not authorize its downstream effect. In particular,
an accepted plan still passes normal decomposition/idempotency checks, and a
governed action still requires its own typed reviewer, permission, or formal
approval. A watchdog may not use an open coordination response to bypass any item
in the disallowed-mutations list above.

### Downstream acceptance criteria

Implementation, security, UI, and QA work for task watchdogs must prove these contract points:

- server tests deny cross-company watched issues, watchdog agents, watchdog issues, blockers, interactions, and assignment targets
- server tests deny paused, terminated, pending-approval, budget-blocked, or otherwise uninvokable watchdog agents
- watchdog-scoped mutations can touch only the watched subtree and the reusable watchdog issue, with activity records for each mutation
- interaction tests prove watchdog runs use the same resolver policy as ordinary agents, without a watchdog-only kind or purpose-marker exception
- interaction tests cover `anyone`, `not_creator`, `human_only`, named addressees, company caps, stale targets, governed actions, newer user comments, low-trust/task-bridge containment, and cross-company denial
- scheduler tests prove live runs, queued wakes, and scheduled retries suppress watchdog wakeups, while terminal, cancelled, blocked, and review leaves are still verified when the subtree has no live path
- tests prove `task_watchdog` origin issues and descendants are excluded from scans so watchdogs do not trigger themselves
- recovery-batch tests prove batches are capped at 3 allowed mutations, applied all-or-nothing, and aborted with recorded evidence when the observed stop fingerprint went stale mid-batch
- restoration-verification tests prove a "live path restored" disposition re-fires on an unchanged fingerprint with an incremented attempt count, a failed intermediate-node restoration is not treated as a reviewed stop, and the N-attempt bound escalates to a human with attempt history instead of firing forever
- regression tests prove watchdog capability discovery comes from wake metadata/denials and denied probes do not create visible issues
- UI copy and badges distinguish task watchdogs from active-run output watchdogs, monitors, reviewers, approvers, and liveness recovery
- prompt/context tests prove custom instructions are appended after non-overridable safety constraints and cannot expand authority
- QA validates a full create/edit/remove/run/reuse flow with screenshots for UI changes

No unresolved policy decision blocks implementation once CTO and Security accept this contract. Deliberately deferred and disallowed for the first implementation: letting watchdogs cancel active runs, approving board/governance actions, mutating outside the watched subtree, or allowing watchdog agents to modify their own watchdog configuration. Any expansion of those capabilities requires a new product/security review.
