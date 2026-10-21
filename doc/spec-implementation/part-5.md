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

See [Issue-thread interactions](../issue-thread-interactions.md) for read routes and resolver rules.
