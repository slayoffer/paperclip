# Implementation specification: part 11

## GitHub-synced skill sources

- Discovery supports opt-in `Accept: application/x-ndjson` on the existing discovery
  endpoint. Progress events report connection/download/tree/package stages, checked skill
  counts, and the current package's file counts; candidate events contain metadata,
  never file contents. Only the final `complete` event makes the scan selectable.
  Interrupted streams discard partial results, and cancellation stops further
  provider reads. The default JSON API remains compatible. The import dialog uses
  reduced-motion-aware animations and shows indeterminate progress while saving
  complete packages, without inventing completion percentages.

- Sources and entries are company-scoped. Reuse GitHub connection grants and credential
  refresh; every provider read authorizes the current caller. Saved connection IDs do
  not confer access to another user's token. Agent reads use managed run identities.
- The import picker searches the deduplicated union of repositories from all connections
  the caller can access, automatically choosing an authorized connection. Adding accounts
  uses the standard GitHub setup in Apps and retains the import draft. Repository URLs
  use the default branch; `/tree/<branch>` URLs select a branch, including slash-containing
  names, without a separate branch or credential selector. Pasted URLs also prefer
  the caller's eligible GitHub connections, including for public repositories;
  anonymous access is used when no authorized connection succeeds. An explicitly
  saved connection must remain authorized. Repository identity still comes from
  the GitHub API; quota errors are distinct from access denials.
- Discover every `SKILL.md`, including hidden/deep directories. Resolve the tracking
  ref to an immutable commit once per operation through a shallow Git fetch. Read
  the complete local Git tree and blobs without checkout, archive transformations,
  or per-file API calls. Git's receiving/preparing percentages feed download progress.
  Git must be installed on the server. Downloads are bounded to 128 MiB and three
  minutes, with two simultaneous downloads and at most four cached/downloading
  snapshots. A ten-minute in-memory index of temporary repositories, scoped by
  company, caller, run, and grant, reuses a pinned snapshot for preview/import;
  authorization is checked before every reuse. No credentials are written to disk
  or inherited from host Git configuration. Cancellation terminates the Git process
  group and removes incomplete downloads. Symlinks and submodules are reported,
  never traversed; nested skill roots are independent package boundaries.
- Select packages as units, with included-file trees and bounded read-only previews.
  Nested packages have independent checkboxes; supporting files have no individual
  selection. Persist file manifests, explicit missing/out-of-package reference findings,
  and declared `compatibility` requirements with source entries. Preview reads reauthorize
  the current caller and audit the requested package at the scanned immutable commit;
  discovery and source metadata contain no file contents. Reference checks are advisory,
  do not establish complete runtime dependencies, and never expand package boundaries.
- Stage and audit complete packages before publishing. Scripts are allowed through
  the existing content audit and never run on import. Persist binary bytes and executable
  flags in immutable version inventories (legacy entries default to UTF-8/non-executable).
- Refresh is serialized per source, checks saved selection revisions, and publishes
  valid skills plus per-entry outcomes with required activity records in one transaction.
  Failed packages retain prior versions; access/scan/download failures retain all content.
  Record attempted and successful refresh times separately.
- Match by repository identity and exact path. Preserve IDs, keys, assignments, folders,
  and history. New key collisions cannot overwrite unrelated skills. Only changed package
  bytes or executable modes create versions. Library reads, tests, and subsequent unpinned
  runs use local installed snapshots; pinned/active runs retain their versions.
- Additions require reviewed selection, with new candidates checked by default and
  explicit folder exclusions retained. Upstream deletion keeps installed content with
  removed status; moves are removal plus discovery. Deselect/disconnect retains content
  and assignments. Originals are read-only, with the existing independent fork workflow.
- Adopt recognizable existing GitHub imports without provider calls or content changes;
  resolve missing repository IDs and full snapshots on successful refresh. Exclude bundled,
  catalog, local/project, skills.sh, and unsupported hosts. Existing GitHub import and update
  endpoints delegate to sources while retaining response shapes.
- GitHub.com, manual refresh only. No upstream editing, polling, webhook sync, commits,
  or pull-request creation in this milestone.

## Public assistant connection (opt-in)

The user-authorized MCP surface connects assistants to an explicitly selected
company as the consenting person. It exposes first-party task reads, additive
task creation and comments, durable documents and approval links. It reuses
existing domain authorization and scheduling; OAuth does not grant agent
identity, native run ownership, approval decisions or third-party credentials.
See [Public MCP](../public-mcp.md) for the implemented instance-side boundary,
configuration, plugin packages and outstanding hosted release gates. The
[delivery plan](../plans/2026-09-30-paperclip-public-mcp-and-plugins.md) separates
external agent participation and granted third-party tools into later releases.

The experimental OpenAI Dot Runner provider uses a separate `/mcp/runner`
agent OAuth resource. It reuses the public gateway's browser/device consent,
client metadata verification and signed event delivery, but requires one-use
agent pairing and normal run admission. Personal grants cannot authorize
Runner operations. See [OpenAI Dot Runner](openai-dot-runner.md) for the
self-hosted release boundary and remaining account qualification.

### Experimental AI connection routing

Opt-in plugin routers may represent a pool as an AI runtime binding. Core keeps
company and credential authorization, atomically records task/agent affinity and
a pool cursor, and persists concrete native recovery evidence. The full contract
is in [AI-CONNECTION-ROUTERS.md](../connections/AI-CONNECTION-ROUTERS.md). Disabled
routing cannot allocate new tasks; already admitted native runs remain recoverable.

### Connection instructions

Connections can store optional, versioned agent instructions independently of
provider and transport. Catalog templates control editor visibility; saved
settings and runtime delivery also support connections without a template.
The server includes instructions only when the connection and at least one
action are available to the run's agent and responsible identity. An immutable
per-turn snapshot participates in session compatibility, so subsequent turns
remove stale instructions after edits or access revocation. See
[Connection instructions](../connections/CONNECTION-INSTRUCTIONS.md) for contracts,
UI conventions, custom adapter integration, and initial memory templates.

### Remote Codex model compatibility

Fresh remote Codex Runner preparation can replace a model whose verified CLI
minimum exceeds the supported image CLI version. It selects a compatible older
model in the same class, then the stable Runner default, and saves that effective
model before checkpoint selection. A visible task warning and local run-log event
record the substitution. This does not change agent settings, rewrite admitted
executions, or bypass artifact, ownership, permission, and budget gates. See
[remote Codex compatibility](execution-semantics.md#remote-codex-model-compatibility).

### Native provider capacity retry

Committed, run-bound Codex `serverOverloaded` terminal failures display the model
capacity error directly and schedule at most two automatic retries, after one
and two minutes. Retries share the execution failure budget, retain task history,
and honor current ownership, review, governance, pause, dependency, budget, and
cleanup gates. Restart or duplicate finalization must not create another
successor. Permanent model/auth incompatibility and usage-limit exhaustion retain
their existing operator recovery requirements.

## Internal agent commentary

`agent_commentary` stores company-scoped, attributed complaints and suggestions
as free-form text in the instance database. Legacy agents use the default
`complain` and `suggestion-box` runtime skills; native runs use dedicated tools
in standard, ask, and planning modes. Submission never changes task disposition
or routes feedback externally. See [Agent commentary](agent-commentary.md) for
authentication, replay, document-sized limits, inspection, and deletion semantics.

## Company decision-model service

Company Settings → General can configure one shared API-key connection for optional internal decisions. V1 supports OpenAI Decisions and Jev through OpenRouter. Companies start unconfigured; background sponsorship defaults on when configured, while an explicit off setting persists. Human and agent calls retain current responsible-user, connection audience, resource, and agent installation checks. Only explicitly registered internal background features can use company sponsorship.

The internal service provides local-only availability and bounded, reauthorized execution. It records metadata-only invocation history and independent fractional service charges in the existing cost ledger, applying company and applicable agent/project budgets under the accounting lock. Unknown dispatch charges retain reservations until audited resolution. Settings/testing require connection management permission; history uses existing cost visibility. See [decision-models.md](decision-models.md) for the contract, supported models, accounting, privacy, and endpoints.

## Company fast-response service

Companies may configure an optional shared API connection and model for short acknowledgements of accepted human turns. Fast responses use direct SDK inference alongside normal agent work, with a three-second admission deadline, bounded prompts/output, current authorization and independent `fast_response` accounting. They are server-marked platform receipts attributed to the agent, never completion, interaction or recovery evidence. Company-sponsored unlinked external senders are explicit; linked-user permission denials are never bypassed. See [fast-responses.md](fast-responses.md) for provider, delivery, history and endpoint contracts.
