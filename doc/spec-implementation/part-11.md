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

- Sources and entries are company-scoped. Discovery and connection changes authorize
  the current caller. Automatic and manual source refresh use the stored setup person's
  connection and grant, revalidating their access and refreshing credentials on each
  check. Saved connection IDs do not independently grant library visibility. Agent
  setup derives the responsible person from the authenticated run identity.
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
  do not establish complete runtime dependencies, and never expand package boundaries automatically.
- New UI imports use `packageMode: repository` to preserve supported repository files
  in one company-scoped immutable snapshot. Selected entrypoints become library skills;
  other skills remain supporting files. The root `paperclip.skills.json` may declare
  version 1, validated `skills` paths and `requirements` text. Invalid manifests fall
  back to discovery. The dialog shows every skill and containing folder, selects all
  discovered skills, and collapses package files. There is no import-mode chooser;
  existing directory-mode sources and API callers remain compatible.
  Unsupported links, oversized files and files rejected for unsafe execution or
  secret disclosure are omitted with persistent warnings. Malformed entrypoints
  stay selected with Needs setup warnings; usable selected skills still publish.
  Limits are 9,990 repository entries, 1 MiB per file and 61 MiB total. The dialog
  exposes included files and setup requirements without repair choices or another
  confirmation. Installed file views read saved repository bytes and resolve links
  from each instruction file's original directory.
- Each repository-backed version references its snapshot and original entrypoint path.
  Runtime materialization adds a discovery wrapper and preserves the original tree under
  `.paperclip-repository/`, including binaries, modes and credits. Original instructions
  are unchanged. `agents/openai.yaml` discovery policy is retained beside the wrapper.
  Existing adapters carry self-contained copies, so multiple entrypoints may duplicate
  runtime bytes. Shared-file changes version all selected skills; pinned runs remain
  on their snapshot. Importing does not install dependencies or configure host tools.
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
- Runtime version directories are disposable caches. An hourly, bounded sweep may
  evict non-current copies unused for one hour, preserving active and unresolved
  execution pins. Selection, materialization, and pin persistence serialize with
  eviction across processes. Missing copies rebuild from immutable database bytes
  without upstream access. See [recoverable disk cleanup](../recoverable-disk-cleanup.md)
  for rollout controls, legacy grace periods, and interrupted cleanup recovery.
- Manually selected sources retain reviewed selection, with new candidates checked by default and
  explicit folder exclusions retained. Upstream deletion keeps installed content with
  removed status; moves are removal plus discovery. Deselect retains content
  and assignments. Originals are read-only, with the existing independent fork workflow.
- Source disconnection requires a saved revision and an explicit copy/delete choice.
  Remove the source and all entries to allow a fresh repository import, including
  legacy disabled sources. Copy materializes complete local files in the caller's
  My Skills folder, retaining skill IDs, keys, versions, and agent assignments.
  Delete applies skills.remove to every linked skill (including deselected entries),
  rejects skills still used by agents, and removes skills and source atomically with
  the activity record. Copy applies skills.edit and skills.create to every linked
  skill; failed writes or audit persistence leave the source and imported skills intact.

- Adopt recognizable existing GitHub imports without provider calls or content changes;
  resolve missing repository IDs and full snapshots on successful refresh. Exclude bundled,
  catalog, local/project, skills.sh, and unsupported hosts. Existing GitHub import and update
  endpoints delegate to sources while retaining response shapes.
- GitHub.com project repository attachments enqueue durable skill-source import jobs in
  the project mutation transaction. Skill import completes asynchronously and cannot
  fail project creation. Configured refs use the existing project workspace precedence;
  absent refs track the default branch. Sources without skills remain tracked.
- Enabled sources check upstream every five minutes; unchanged commits avoid downloads.
  Manual Refresh uses the same serialized publication pipeline. Automatic updates may
  be paused independently of selection. Project sources select future additions unless
  excluded; existing manually imported sources retain their selections. Legacy projects
  adopt through an explicit company-scoped, project-authorized endpoint, never a GET.
- Repository size fallback first retains skill folders and transitively referenced
  repository files within the existing file/byte limits, preserving original paths.
  If that set is still too large, bounded skill folders remain importable. Missing
  references are advisory and do not invalidate otherwise valid selected skills.
  Web routes and inline Markdown examples are not package dependencies. Preserve
  installed versions if fallback would omit their previously installed shared files.
  Project sources retry complete packaging; selections and exclusions remain unchanged.
  Refresh reinspects cached dependency-rejection errors once even at an unchanged
  upstream commit. Content validation and company/project access remain enforced.
- Unattended refresh stores setup identity and connection/grant identifiers, never token
  values. Current membership, connection authorization and skill policy are revalidated.
  Unrecoverable legacy setup identities require explicit connection repair. Retries are
  bounded and backed off; leases survive restarts and shutdown cancels owned downloads.
- Project-derived skill visibility is the union of current originating project audiences.
  Core uses project authorization, including agent/responsible-user intersection, for
  discovery, reads, mutations, files, versions, tests and runtime delivery. Unauthorized
  IDs return not found. Company imports retain their existing visibility. Forks preserve
  project provenance. Unsupported public publication or portable export is rejected.
- Detachment retains installed content and project access provenance while stopping that
  project's tracking. Ref replacement never rewrites existing references. An orphaned
  project source remains restricted after its last originating project is deleted.
- Executions resolve unpinned references from local immutable versions, persist the
  resolved inventory, and reuse it on resume after rechecking access. Explicit unavailable
  references fail actionably rather than silently omitting instructions. Background
  GitHub checks never delay execution. Existing version pins remain supported.
- Upstream editing, push webhooks, commit/PR creation and advanced reference pin UI
  remain outside this release.

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
Runner operations. See [OpenAI Dot Runner](../openai-dot-runner.md) for the
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
[remote Codex compatibility](../execution-semantics.md#remote-codex-model-compatibility).

### Native provider capacity retry

Committed, run-bound Codex `serverOverloaded` terminal failures display the model
capacity error directly and schedule at most two automatic retries, after one
and two minutes. Retries share the execution failure budget, retain task history,
and honor current ownership, review, governance, pause, dependency, budget, and
cleanup gates. Restart or duplicate finalization must not create another
successor. Permanent model/auth incompatibility and usage-limit exhaustion retain
their existing operator recovery requirements.

## Internal agent commentary

Audit → Commentary is a board-only page with agent/type filters, text search,
50-message pages and full-message dialogs. Filters, page offsets and selected
messages have shareable URLs. Read endpoints require company membership,
`commentary:view` and source-task visibility. All human company roles, including
viewers, receive this permission by default. An upgrade migration grants it to
existing active human members while preserving existing commentary grants.
Human invitation approval adds the commentary default when a saved grant list
omits it, including invitations created before the upgrade, and preserves explicit scopes.
The separate `audit:view_agent_actions` permission continues to govern agent-action
audit reads, detailed audit filters and CSV exports.

`agent_commentary` stores company-scoped, attributed complaints and suggestions
as free-form text in the instance database. Legacy agents use the default
`complain` and `suggestion-box` runtime skills; native runs use dedicated tools
in standard, ask, and planning modes. Submission never changes task disposition
or routes feedback externally. See [Agent commentary](../agent-commentary.md) for
authentication, replay, document-sized limits, inspection, and deletion semantics.

## Company decision-model service

Company Settings → General can configure one shared API-key connection for optional internal decisions. V1 supports OpenAI Decisions and Jev through OpenRouter. Companies start unconfigured; background sponsorship defaults on when configured, while an explicit off setting persists. Human and agent calls retain current responsible-user, connection audience, resource, and agent installation checks. Only explicitly registered internal background features can use company sponsorship.

The internal service provides local-only availability and bounded, reauthorized execution. It records metadata-only invocation history and independent fractional service charges in the existing cost ledger, applying company and applicable agent/project budgets under the accounting lock. Unknown dispatch charges retain reservations until audited resolution. Settings/testing require connection management permission; history uses existing cost visibility. See [decision-models.md](../decision-models.md) for the contract, supported models, accounting, privacy, and endpoints.


### Task workspace ownership (2026-10-09)
