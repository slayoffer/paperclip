# Review bridge waits

## Bounded wait contract

Use this contract for verdict, merge-card, or lane-admission waits.
It works with either setting of `PAPERCLIP_BLOCKED_STATE_INTEGRITY`.
A wait grants no merge, deployment, or execution authority.

Save the owner handoff first. Then send this descriptor through `PATCH /api/issues/{issueId}`:

```json
{
  "status": "blocked",
  "unblockDescriptor": {
    "kind": "review_bridge",
    "owner": "board",
    "action": "Wait for the review bridge verdict.",
    "until": "2026-10-23T03:00:00Z",
    "bridge": {
      "waitId": "5ac12285-5032-41a0-b560-bca1dc44ae2a",
      "repo": "owner/repository",
      "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "pr": 42,
      "stage": "verdict"
    }
  }
}
```

Set `until` to a future UTC time within seven days. The example time is illustrative.
Generate a new UUID for each `waitId`. A consumed identifier cannot start another wait.
The `head` must match the latest saved owner handoff. The repository must also match.
The branch must be `review/<issue identifier>`. The owner must remain assigned.
The descriptor can name `board` or the assigned agent as its owner.
It cannot name another agent or a named user.
The `pr` field is optional. The head is required.
The stage is `verdict`, `merge_card`, or `lane_admission`.

The bridge reads the descriptor from the issue. It writes one matching block in a comment or issue document:

````text
```bridge-event
{"waitId":"5ac12285-5032-41a0-b560-bca1dc44ae2a","repo":"owner/repository","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pr":42,"stage":"verdict"}
```
````

Use authenticated board authorship. An agent-authored block does not resolve a wait.
Each target field must match, including `waitId`, stage, and the presence of `pr`.
Use one block. Quoted blocks, invalid JSON, and additional fields do not qualify.
Document revisions retain events if a later revision replaces their text.
A stale event does not wake the owner or clear a newer wait.
Ordinary comments do not implicitly reopen a bridge wait.
The board can explicitly resume the issue through the existing routes.

A matching event atomically clears the descriptor and changes the issue to `todo`.
The same transaction saves a durable wake intent.
The wake reason is `review_bridge_event`. Its context names the target and source comment or document revision.
Without an event, expiry releases the wait with reason `review_bridge_timeout`.
That context includes the expired deadline and target.
The periodic recovery sweep and startup recovery process outstanding waits and wake intents.
An expired wait creates one intent. A stable admission receipt prevents repeated timeout delivery after a restart.
A failed dispatch remains pending. A skipped admission can retry after its gate clears.

Recovery leaves recorded bridge waits alone, including expired waits that await their timeout transaction.
A pending durable intent also prevents disposition recovery.
A bridge event or explicit board resume clears stopped disposition-repair bookkeeping.
Provider execution holds and workspace safety holds remain active.
Pause holds defer dispatch. Normal company, agent, budget, dependency, and execution gates still apply.
No human card is required to declare or resolve this wait.

## Legacy saved review waits

The Synthiq fork permits an agent to record a board-owned review wait on its own issue.
The wait does not grant merge or deployment permission.

First, save a comment with one handoff block:

````text
```handoff
repo: owner/repository
base: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch: review/EXAMPLE-42
```
````

Then send one `PATCH /api/issues/{issueId}` request:

```json
{
  "status": "blocked",
  "unblockDescriptor": {
    "owner": "board",
    "action": "waiting for the cross-vendor review of aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

The action must use this exact form. Letter case can differ.
The head must contain exactly 40 hexadecimal characters.
The branch must be `review/<issue identifier>`.
The manifest must contain exactly the four fields shown above.
The fields can appear in any order. Hexadecimal letter case can differ in both heads.

The server checks the latest handoff comment from the current issue owner.
It restricts the query to the same company and issue. It excludes deleted comments.
A newer handoff replaces the previous head. A quoted handoff does not qualify.
A handoff in the same PATCH does not qualify because the server requires saved evidence.
The agent must remain the assignee after the PATCH.

The exception permits only the board owner. It does not permit another agent or a named user.
Other external owners still return HTTP 403.
For a legacy descriptor without a typed target, `PAPERCLIP_SELF_BLOCK_GUARD=true` can still reject a self-owned wait.
Normal company access, checkout, mutation authorization, and activity logging still apply.

The board or review bridge uses the existing issue update route to clear the wait.
This change does not add automatic review rounds or automatic release actions.
