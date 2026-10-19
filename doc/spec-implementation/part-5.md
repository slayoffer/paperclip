# Implementation specification: part 5

## 9.8 Scoped Task Assignment Grants

`tasks:assign` remains the broad assignment permission. Existing unscoped grants preserve compatibility and allow the principal to assign any visible company task within normal company-boundary checks.

`tasks:assign_scope` is the constrained assignment permission. Its `principal_permission_grants.scope` JSON must include at least one recognized constraint:

- Project scope: `projectId`, `projectIds`, or `allow: ["project:<projectId>"]`.
- Target-agent allowlist: `agentId`, `agentIds`, `assigneeAgentId`, `assigneeAgentIds`, `targetAgentId`, `targetAgentIds`, or `allow: ["agent:<agentId>"]`.
- Managed-subtree scope: `managerAgentId`, `managerAgentIds`, `managedSubtreeAgentId`, `managedSubtreeAgentIds`, `subtreeAgentId`, `subtreeAgentIds`, `subtreeRootAgentId`, `subtreeRootAgentIds`, or `allow: ["subtree:<agentId>"]`.

When multiple constraint families are present, assignment must satisfy all of them. Denials return `403` with a generic scope explanation and do not disclose details about hidden or unrelated resources.

A protected-agent hard block is represented canonically as
`authorizationPolicy.protectedAgent.blockAssignment: true`. It denies assignment
even when the caller has a broad or scoped assignment grant. A company
administrator must remove the block before assignment can be retried; no pending
approval is created. The legacy fields `protectedAgent.requiresApproval` and
`assignmentPolicy.protectedAgentRequiresApproval` remain fail-closed compatibility
aliases for the same hard block, but API denial copy must describe the block and
administrator remediation rather than promising a nonexistent approval step.

### 9.8.1 Issue-thread interaction resolver contract

Issue-thread interactions are coordination records, not grants of authority. Every
interaction kind defaults to resolver policy `anyone` when the create request omits
`resolverPolicy`. Restrictions are opt-in.

Question, confirmation, checkbox confirmation, and item verdict cards stay pending
when a user sends an ordinary task comment. Their `supersedeOnUserComment` flag
defaults to `false`. A creator may set it to `true` when a comment should replace
the pending request, as the opening onboarding question does.

Canonical resolver policies are:

- `anyone`: any authenticated actor in the interaction's company who can read the
  issue and use the normal resolution route. For agents this includes the creator
  agent and the creating/source run.
- `not_creator`: the explicit independent-review policy. It excludes the creator
  agent and creating/source run while otherwise using the ordinary agent resolver
  path.
- `human_only`: only an authorized human/board actor may resolve the interaction.

`board_or_agents` and `board_only` are deprecated migration and API-input aliases.
For new writes they normalize to `anyone` and `human_only`, respectively. API reads
return canonical requested/effective policies, compatibility aliases, and immutable
provenance. The persisted provenance is `explicit`, `inherited`, or
`legacy_inherited_restriction`; the effective-policy source is `requested`,
`company_cap`, or `governed_action`.

Historical rows predate explicit-vs-inherited provenance. Migration must never
silently widen an ambiguous pending card: legacy `board_or_agents` rows retain the
old creator-excluding behavior as canonical `not_creator`, legacy `board_only` rows
become `human_only`, and both are marked `legacy_inherited_restriction`. Resolved
outcomes and resolver attribution are immutable.

An explicit named agent or user addressee and a company-configured cap may narrow
the effective audience. Only the exact named addressee may resolve an addressed
interaction; a human does not override a user addressee. Explicit user recipients
must exist and be authorized to respond in the issue's company before creation.
Ordinary Agent Chat questions derive their user recipient from the persisted
conversation owner. A conflicting explicit user recipient is rejected; IDs are
never guessed or repaired. Ordinary task questions keep optional addressing.
A cap never widens the requested audience. Tool-action confirmations and
other hard-governed action cards remain `human_only` (or move to the formal approval
system) regardless of a requested open audience.

Surfaces that offer a resolution must state the effective audience before the
operator acts, from server metadata rather than a client-side policy inference.
Issue-thread cards read it from the interaction snapshot; attention rows read it
from the feed item's `resolverAudience` (canonical requested/effective policy,
effective-policy source, provenance, and the addressee/creator identities the
evaluator compares against), because a collapsed row carries decision verbs
before the interaction itself is fetched. A failed resolution keeps the server's
denial reason in visible, assertively announced feedback and names who may
respond; an audience denial is permanent, so it must not degrade to a retry
prompt. Neither surface may enable or disable a control on its own authority.

Every resolution remains company-scoped, run-attributed for agent actors,
low-trust/task-bridge contained, target-current, and exact-once. Target staleness,
supersession, continuation idempotency, and activity attribution remain mandatory.
An open audience is not an uncapped one: when an agent run resolves an interaction
on an issue other than its own source issue, the resolution is a cross-issue
mutation and consumes the per-run cross-issue influence budget in §9.3, charged
after audience authorization and before the interaction mutation, child tasks,
continuation, tool action, or wake. Same-issue resolutions and board/user
resolutions are outside that counter.
Accepting or answering an interaction records a response only: suggested-task
creation, provider/tool calls, deployment, spend, hiring, secrets, execution-policy
decisions, and every other downstream effect must re-run its own authorization and
approval checks. Mislabeling a governed action as an open interaction grants no
downstream capability.
