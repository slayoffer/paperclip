# Guild issue intake check

The Synthiq fork can check P7 section names before an agent starts Guild work.
The check applies only to company `d057bef7-f0b9-48e4-bb19-2e41feee0e53`.
Other companies keep their existing pickup behavior.

## Operator switch

`PAPERCLIP_ISSUE_INTAKE_CHECK` supports these values:

| Value | Result |
| --- | --- |
| `off` | Default. The check does not read the database or refuse work. |
| `dry_run` | Log missing section names. Permit pickup. Do not add a comment. |
| `enforce` | Refuse pickup when section names are missing. Add one system comment per issue. |

An unset, empty, or unknown value means `off`. The server reads the switch on each check.
Start with `dry_run`. Check the structured server events before an operator selects `enforce`.
To disable the check, an operator selects `off` or removes the variable.
This change does not set an environment variable on any host.

## Required sections

The issue description must contain all four names:

```markdown
## Intent
State the intended result.

## Acceptance
State the conditions that prove the result.

## Non-functional limits
State the resource, performance, and safety limits.

## Out of scope
State the excluded work.
```

The parser accepts case differences. It also accepts bold names such as `**Intent**` or `**Intent:**`.
Bold names can have text on the same line. Level-two headings can contain bold names or closing hashes.
Prose mentions and fenced code examples do not count.
The check validates section names only. It does not evaluate the content or require nonempty section bodies.

## Exemptions

- Issues with a current, company-scoped `owner:local-session` label.
- Titles that start with `Review hold:`.
- Legacy bridge titles that start with `Review r<N>:` or `Gate `.
- Titles that end with `(bridge-owned, do not edit)`.
- Issues with the server-recorded `task_bridge` origin.

The legacy title conventions also appear in the company-flow model.
They identify bridge work without a schema change. A manually copied bridge title also receives the exemption.
The local-session exemption only skips intake validation. The existing owner parking rule still prevents agent runs.

## Admission and refusal

The issue service checks intake before checkout changes the issue.
Heartbeat checks intake at wake admission, queued-run claim, and provider dispatch.
These checks read current issue data and labels. A saved wake payload cannot supply an exemption.
Queued runs that fail the check are cancelled after the agent start lock ends.
The cancellation suppresses immediate recovery.

`issue-start-readiness.ts` owns checkout assignability and intake validation.
`queued-claim-rejection.ts` classifies queued claim errors and settles rejected runs.
Heartbeat calls settlement after the agent start lock ends, because cancellation can promote the next queued run.
These modules keep the service coordinators smaller than the release base without file-size exceptions.

In `dry_run` and `enforce`, a failed check writes a structured server event:

```json
{
  "event": "issue.intake_check",
  "mode": "dry_run",
  "source": "heartbeat.admission",
  "missingSections": ["Acceptance", "Out of scope"],
  "refused": false
}
```

The event also contains `companyId` and `issueId`. It does not include the description.
Repeated attempts can produce repeated log events.

In `enforce`, checkout returns HTTP 409 with code `issue.intake_missing_sections`.
Wake admission records a skipped request with that reason and creates no run.
The first refusal adds a comment that starts with `[no-wake]` and names the missing sections.
The server inserts the system comment directly. It sends no wake, mention, or plugin event.
It does not change issue status, assignment, or recency.

The durable comment key is `issue-intake:v1:<issue-id>` in `clientRequestId`.
An issue row lock serializes the key check and comment insert.
Repeated attempts, concurrent attempts, and server restarts therefore keep one comment.
The first refusal also records `issue.intake_refused` in the local activity log.
The marker does not expire when the description changes. The original comment can contain an old missing-section list.
Each later check still reads the current description. A corrected issue can proceed on its next pickup attempt.

## Verification

Run the focused suite on a host with Node 24 and embedded PostgreSQL support:
In a fresh checkout, first build the plugin SDK for the heartbeat imports:

```sh
pnpm --filter @paperclipai/plugin-sdk build
pnpm exec vitest run server/src/services/issue-intake-check.test.ts --maxWorkers=1
```

The suite checks parser forms, all modes, real checkout and wake admission, concurrent comment insertion,
company boundaries, current labels, bridge exemptions, corrected descriptions, and queued-run cancellation.
It does not start an external agent provider.
