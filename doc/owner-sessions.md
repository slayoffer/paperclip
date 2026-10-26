# Owner sessions

The Synthiq fork can resume one provider thread per agent and project.
The default is off. This option supports the Codex and Claude command engines.
Set the agent adapter's `engine` to `cli` before the canary.
Native Runner, ACP, conversation tasks, and review confinement keep their existing session rules.

The operator sets these server environment variables:

| Variable | Value |
| --- | --- |
| `PAPERCLIP_OWNER_SESSIONS_ENABLED` | `true` enables owner sessions. Other values disable them. |
| `PAPERCLIP_OWNER_SESSION_AGENT_IDS` | Comma-separated agent IDs select canary owners. An empty value selects all supported owners. |
| `PAPERCLIP_OWNER_SESSION_MAX_INPUT_TOKENS` | A positive integer overrides the existing raw input limit. An absent or invalid value keeps the agent policy. |

For example, select one owner and set an input limit of `3000000`.
Homelab owns the server deployment and canary. This feature requires no database migration.

## Execution

The session row uses `owner-project:<project-id>` in `agent_task_sessions`.
The existing company, agent, and adapter columns remain part of its unique key.
Selected agents admit at most one active run. This serializes their provider threads.
The owner project comes only from the current issue row. A wake's project or task key never selects an owner row.
Task keys that start with `owner-project:` are reserved. Paperclip ignores them in wake data.
A run saves the owner row before it leaves `running`, so the next run reads the current thread.
A finalizer whose run already left `running`, or whose row moved to another run, writes nothing.
An issue-scoped session reset also clears the owner row of that issue's project, so the next wake starts a fresh thread.

The provider starts in a stable owner directory. Each turn names its issue worktree and branch.
With `filesystemScope: "workspace"`, the sandbox mounts the owner directory and the issue workspace read-write.
The agent executes repository commands in that worktree inside the resumed thread.
Paperclip retains the existing issue checkout and workspace controls.
It does not switch branches in a shared repository checkout.

Local owner directories reside under the existing agent workspace.
SSH owner directories use `~/.paperclip/owner-sessions/<company>/<agent>/<project>` on the selected host.
Provider transcripts persist there. Each turn still receives fresh runtime assets through the existing transport.
Temporary runtime cleanup preserves the transcripts.

Resumed owner turns receive the current wake and workspace instructions.
The first turn for a different issue includes its full assignment, also on a comment or timer wake.
Later turns omit the repeated assignment. Resumed turns omit repeated agent instructions.
The agent can read the current issue when it needs more context.
Issue comments and answered cards use the existing wake delivery rules.

## Session replacement

Host identity checks remain mandatory. A different host starts a fresh provider thread.
The new thread receives the current task handoff and the previous owner summary.
The existing configuration and credential checks can also require a fresh thread.
Context from another issue grants no approval for the current issue.

The existing compaction policy controls run count, input tokens, and age.
The optional input limit above uses that same handoff path.
Owner limits sum normalized input tokens across the thread. This also covers Claude per-run totals.
Codex command output reports cumulative usage. Owner mode subtracts the latest valid session total for each wake.
Task-keyed Codex CLI sessions use the same cumulative declaration and subtraction.
`codex exec resume` emits thread totals in `turn.completed`, so each wake records only the increase.
The adapter fixture `resume-usage.json` cites the Codex 0.162.1 implementation and checks this declaration.
A failed turn without usage does not reset that total.
The canary query in `server/scripts/owner-session-baseline.sql` skips such turns the same way.
Claude retains its per-run usage accounting.

Disable the switch to restore task-keyed sessions and the existing workspace behavior.
Owner rows remain separate from task rows. Disabling the switch does not delete either set.

## Canary evidence

Record the deployed commit and selected owner before the comparison.
Use the query in `server/scripts/owner-session-baseline.sql` for both windows.
Compare the resumed share and median input tokens per wake.
Count terminal runs without session IDs as unknown.
The initial Codex baseline has a resumed share of `0.09%` and a fresh median of `1,199,689` input tokens.
The canary must show resumed runs and a lower median than that fresh baseline.

Run the focused tests with:

```sh
pnpm exec vitest run server/src/__tests__/owner-sessions.test.ts server/src/__tests__/owner-session-guards.test.ts packages/adapter-utils/src/remote-managed-runtime.sessions.test.ts packages/adapter-utils/src/prompt-sections.test.ts packages/adapter-utils/src/local-process-sandbox-launch-dir.test.ts --no-file-parallelism
```
