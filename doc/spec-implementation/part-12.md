# Implementation specification: part 12

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

Invariant: plaintext key shown once at creation; only hash stored.

### Agent cryptographic identity

Each agent also has one Ed25519 identity in `agent_identity_keys`, separate from
API bearer keys and company secrets. New-agent creation provisions it atomically;
existing agents provision lazily before their first managed run. The schema-only
migration and public reads never provision existing agents. Private PKCS#8 PEM
material uses `local_encrypted`; public SPKI PEM and its SHA-256 key ID are readable
through `GET /api/agents/:id/identity` and the agent Identity section. Managed
processes receive the pair through runtime-only environment fields. See
[Agent cryptographic identity](../AGENT-IDENTITY.md) for storage, runtime, and copy
semantics.

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

Invariant: at least one root `company` level goal per company.

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `visibility` enum-like text: `open | private`, default `open`
- `personal_owner_user_id` text null; unique with `company_id` when present
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null
- `env` jsonb null (same secret-aware env binding format used by agent config)

Invariant:

- project env is merged into run environment for issues in that project and overrides conflicting agent env keys before Paperclip runtime-owned keys are injected

Routine execution issues add a routine-scoped env overlay after project env and before Paperclip runtime-owned keys. Routine env uses the same secret-aware binding format, is stored on `routines.env`, is snapshotted in routine revisions, and resolves secret refs against the routine binding target so routine-owned secrets do not require direct bindings on the executing agent.

Project source repositories use the existing `project_workspaces` collection.
Each selected GitHub repository has a canonical `repo_url` and stable provider ID
in `metadata.githubRepositoryId`; the first workspace remains the execution default.
The board can select multiple repositories from its usable personal and shared
GitHub grants. Selection does not grant runtime credential access. Legacy workspace
URLs remain valid. Project creation and repository replacement are transactional.
See `doc/project-repositories.md` for the API and UI contract.
