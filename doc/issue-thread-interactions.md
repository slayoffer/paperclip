## Issue-thread interaction resolver contract

The read route `GET /api/companies/:companyId/interactions` lists interactions
across readable issues in one company. It returns `{ items, nextCursor }`.
Each item has the per-issue interaction fields and `issueIdentifier`.
`issueIdentifier` can be null when an issue has no identifier.

The query accepts `status`, `kind`, `issueId`, `limit`, and `cursor`.
`limit` defaults to 1000 and must be an integer from 1 through 1000.
Results use ascending interaction UUID order. The cursor is the last returned
interaction UUID. Continue with `cursor=nextCursor` until `nextCursor` is null.
Pagination does not provide a snapshot when interactions change between requests.

Status filtering runs in SQL. Pending interactions on done or cancelled issues
appear as expired, as they do on the per-issue read route. Reads do not persist
this expiry. Company access and issue read permissions apply before pagination.
The route preserves resolver policy fields and workspace acceptance blockers.



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
