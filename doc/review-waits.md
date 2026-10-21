# Saved review waits

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
With `PAPERCLIP_SELF_BLOCK_GUARD=true`, a self-owned wait still returns HTTP 409 with `self_block_refused`.
Normal company access, checkout, mutation authorization, and activity logging still apply.

The board or review bridge uses the existing issue update route to clear the wait.
This change does not add automatic review rounds or automatic release actions.
