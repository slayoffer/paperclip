# Paperclip V1 Implementation Spec

Status: Implementation contract for first release (V1)
Date: 2026-04-28
Audience: Product, engineering, and agent-integration authors
Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code

## 1. Document Role

See [details](spec-implementation/part-1.md#1-document-role).

The Synthiq fork provides an optional [guarded pull queue](pull-queue.md).
`PAPERCLIP_PULL_QUEUE_ENABLED=true` enables event selection, real-work counts, ghost release, and monitor protection.
The default is off. Normal run admission, budget limits, and governance gates remain authoritative.

The Synthiq fork supports [persistent owned task drains](task-drain.md).
A finite lease blocks admission across server recreation.
Lease release requires the authenticated owner and the matching lease ID.

## 2. V1 Outcomes

See [details](spec-implementation/part-1.md#2-v1-outcomes).

## 3. Explicit V1 Product Decisions

See [details](spec-implementation/part-1.md#3-explicit-v1-product-decisions).

## 4. Current Baseline (Repo Snapshot)

See [details](spec-implementation/part-1.md#4-current-baseline-repo-snapshot).

## 5. V1 Scope

See [details](spec-implementation/part-1.md#5-v1-scope).

## 5.1 In Scope

See [details](spec-implementation/part-1.md#51-in-scope).

## 5.2 Out of Scope (V1)

See [details](spec-implementation/part-1.md#52-out-of-scope-v1).

## 6. Architecture

See [details](spec-implementation/part-1.md#6-architecture).

## 6.1 Runtime Components

See [details](spec-implementation/part-1.md#61-runtime-components).

## 6.2 Data Stores

See [details](spec-implementation/part-1.md#62-data-stores).

## 6.3 Background Processing

See [details](spec-implementation/part-1.md#63-background-processing).

## 7. Canonical Data Model (V1)

See [details](spec-implementation/part-1.md#7-canonical-data-model-v1).

## 7.0 Auth Tables

See [details](spec-implementation/part-1.md#70-auth-tables).

## 7.1 `companies`

See [details](spec-implementation/part-1.md#71-companies).

## 7.2 `agents`

See [details](spec-implementation/part-1.md#72-agents).

## 7.3 `agent_api_keys`

See [details](spec-implementation/part-1.md#73-agent_api_keys).

## 7.4 `goals`

See [details](spec-implementation/part-1.md#74-goals).

## 7.5 `projects`

See [details](spec-implementation/part-1.md#75-projects).

## 7.6 `issues` (core task entity)

See [details](spec-implementation/part-2.md#76-issues-core-task-entity).

## 7.7 `issue_comments`

See [details](spec-implementation/part-2.md#77-issue_comments).

## 7.8 `heartbeat_runs`

See [details](spec-implementation/part-2.md#78-heartbeat_runs).

## 7.9 `cost_events`

See [details](spec-implementation/part-2.md#79-cost_events).

## 7.10 `approvals`

See [details](spec-implementation/part-2.md#710-approvals).

## 7.11 `activity_log`

See [details](spec-implementation/part-2.md#711-activity_log).

## 7.12 `project_memberships` + `agent_memberships`

See [details](spec-implementation/part-2.md#712-project_memberships--agent_memberships).

## 7.13 `company_secrets` + `company_secret_versions`

See [details](spec-implementation/part-2.md#713-company_secrets--company_secret_versions).

## 7.14 Required Indexes

See [details](spec-implementation/part-2.md#714-required-indexes).

## 7.15 `assets` + `issue_attachments`

See [details](spec-implementation/part-2.md#715-assets--issue_attachments).

## 7.15 `documents` + `document_revisions` + `issue_documents`

See [details](spec-implementation/part-2.md#715-documents--document_revisions--issue_documents).

## 7.16 Current Implementation Addenda

See [details](spec-implementation/part-3.md#716-current-implementation-addenda).

## 8. State Machines

See [details](spec-implementation/part-3.md#8-state-machines).

## 8.1 Agent Status

See [details](spec-implementation/part-3.md#81-agent-status).

## 8.2 Issue Status

See [details](spec-implementation/part-3.md#82-issue-status).

## 8.3 Approval Status

See [details](spec-implementation/part-3.md#83-approval-status).

## 9. Auth and Permissions

See [details](spec-implementation/part-3.md#9-auth-and-permissions).

## 9.1 Board Auth

See [details](spec-implementation/part-3.md#91-board-auth).

## 9.2 Agent Auth

See [details](spec-implementation/part-3.md#92-agent-auth).

## 9.3 Permission Matrix (V1)

See [details](spec-implementation/part-4.md#93-permission-matrix-v1).

### 9.3.1 Shared default-open issue writes

See [details](spec-implementation/part-4.md#931-shared-default-open-issue-writes).

## 9.4 Permission Terminology and Default Visibility Rule

See [details](spec-implementation/part-4.md#94-permission-terminology-and-default-visibility-rule).

## 9.5 Core V1 Rule: what “private” means

See [details](spec-implementation/part-4.md#95-core-v1-rule-what-private-means).

## 9.6 V1 vs Pro/Enterprise Controls (recommended target split)

See [details](spec-implementation/part-4.md#96-v1-vs-proenterprise-controls-recommended-target-split).

## 9.7 Recommended first-slice implementation order

See [details](spec-implementation/part-4.md#97-recommended-first-slice-implementation-order).

## 9.8 Scoped Task Assignment Grants

See [details](spec-implementation/part-5.md#98-scoped-task-assignment-grants).

### 9.8.1 Issue-thread interaction resolver contract

See [Issue-thread interactions](issue-thread-interactions.md) for read routes and resolver rules.

## 9.9 Task Watchdog Authority Contract

See [details](spec-implementation/part-6.md#99-task-watchdog-authority-contract).

### Allowed watchdog mutations

See [details](spec-implementation/part-6.md#allowed-watchdog-mutations).

### Atomic recovery batch

See [details](spec-implementation/part-6.md#atomic-recovery-batch).

### Restoration verification and escalation

See [details](spec-implementation/part-6.md#restoration-verification-and-escalation).

### Disallowed watchdog mutations

See [details](spec-implementation/part-6.md#disallowed-watchdog-mutations).

### Interaction resolution

See [details](spec-implementation/part-6.md#interaction-resolution).

### Downstream acceptance criteria

See [details](spec-implementation/part-6.md#downstream-acceptance-criteria).

## 9.10 Company Skill Policy Contract

See [details](spec-implementation/part-7.md#910-company-skill-policy-contract).

### Product default

See [details](spec-implementation/part-7.md#product-default).

### Canonical actions and resources

See [details](spec-implementation/part-7.md#canonical-actions-and-resources).

### Version 1 policy document

See [details](spec-implementation/part-7.md#version-1-policy-document).

### Core API and ownership boundary

See [details](spec-implementation/part-7.md#core-api-and-ownership-boundary).

### Compatibility and availability

See [details](spec-implementation/part-7.md#compatibility-and-availability).

### Required regression tests

See [details](spec-implementation/part-7.md#required-regression-tests).

## 9.11 Inbox Management Permission and Ownership Contract

See [details](spec-implementation/part-7.md#911-inbox-management-permission-and-ownership-contract).

## 10. API Contract (REST)

See [details](spec-implementation/part-7.md#10-api-contract-rest).

## 10.1 Companies

See [details](spec-implementation/part-7.md#101-companies).

## 10.1.1 Organization navigation and Cloud invitations

See [details](spec-implementation/part-8.md#1011-organization-navigation-and-cloud-invitations).

## 10.2 Goals

See [details](spec-implementation/part-8.md#102-goals).

## 10.3 Agents

See [details](spec-implementation/part-8.md#103-agents).

## 10.4 Tasks (Issues)

See [details](spec-implementation/part-8.md#104-tasks-issues).

### 10.4.1 Atomic Checkout Contract

See [details](spec-implementation/part-8.md#1041-atomic-checkout-contract).

## 10.5 Projects

See [details](spec-implementation/part-8.md#105-projects).

## 10.6 Current-user Resource Memberships

See [details](spec-implementation/part-8.md#106-current-user-resource-memberships).

## 10.7 Approvals

See [details](spec-implementation/part-8.md#107-approvals).

## 10.8 Cost and Budgets

See [details](spec-implementation/part-8.md#108-cost-and-budgets).

## 10.9 Activity and Dashboard

See [details](spec-implementation/part-8.md#109-activity-and-dashboard).

## 10.10 Error Semantics

See [details](spec-implementation/part-8.md#1010-error-semantics).

## 10.11 Current Implementation API Addenda

See [details](spec-implementation/part-8.md#1011-current-implementation-api-addenda).

## 11. Heartbeat and Adapter Contract

See [details](spec-implementation/part-8.md#11-heartbeat-and-adapter-contract).

## 11.1 Adapter Interface

See [details](spec-implementation/part-8.md#111-adapter-interface).

### Local adapter engine availability

See [details](spec-implementation/part-8.md#local-adapter-engine-availability).

## 11.2 Process Adapter

See [details](spec-implementation/part-8.md#112-process-adapter).

## 11.3 HTTP Adapter

See [details](spec-implementation/part-8.md#113-http-adapter).

## 11.4 Context Delivery

See [details](spec-implementation/part-8.md#114-context-delivery).

## 11.5 Recovery Work Classes

See [details](spec-implementation/part-8.md#115-recovery-work-classes).

## 11.6 Scheduler Rules

See [details](spec-implementation/part-8.md#116-scheduler-rules).

## 11.7 Durable agent session goals

See [details](spec-implementation/part-9.md#117-durable-agent-session-goals).

## 12. Governance and Approval Flows

See [details](spec-implementation/part-9.md#12-governance-and-approval-flows).

## 12.1 Hiring

See [details](spec-implementation/part-9.md#121-hiring).

## 12.2 CEO Strategy Approval

See [details](spec-implementation/part-9.md#122-ceo-strategy-approval).

## 12.3 Board Override

See [details](spec-implementation/part-9.md#123-board-override).

## 12.4 Connection Tool Reviews

See [details](spec-implementation/part-9.md#124-connection-tool-reviews).

## 13. Cost and Budget System

See [details](spec-implementation/part-9.md#13-cost-and-budget-system).

## 13.1 Budget Layers

See [details](spec-implementation/part-9.md#131-budget-layers).

## 13.2 Enforcement Rules

See [details](spec-implementation/part-9.md#132-enforcement-rules).

## 13.3 Cost Event Ingestion

See [details](spec-implementation/part-9.md#133-cost-event-ingestion).

## 13.4 Rollups

See [details](spec-implementation/part-9.md#134-rollups).

## 14. UI Requirements (Board App)

See [details](spec-implementation/part-9.md#14-ui-requirements-board-app).

## 15. Operational Requirements

See [details](spec-implementation/part-9.md#15-operational-requirements).

## 15.1 Environment

See [details](spec-implementation/part-9.md#151-environment).

## 15.2 Migrations

See [details](spec-implementation/part-9.md#152-migrations).

## 15.3 Logging and Audit

See [details](spec-implementation/part-9.md#153-logging-and-audit).

## 15.4 Reliability Targets

See [details](spec-implementation/part-9.md#154-reliability-targets).

## 16. Security Requirements

See [details](spec-implementation/part-9.md#16-security-requirements).

## 17. Testing Strategy

See [details](spec-implementation/part-9.md#17-testing-strategy).

## 17.1 Unit Tests

See [details](spec-implementation/part-9.md#171-unit-tests).

## 17.2 Integration Tests

See [details](spec-implementation/part-9.md#172-integration-tests).

## 17.3 End-to-End Tests

See [details](spec-implementation/part-9.md#173-end-to-end-tests).

## 17.4 Regression Suite Minimum

See [details](spec-implementation/part-9.md#174-regression-suite-minimum).

## 18. Delivery Plan

See [details](spec-implementation/part-9.md#18-delivery-plan).

## Milestone 1: Company Core and Auth

See [details](spec-implementation/part-9.md#milestone-1-company-core-and-auth).

## Milestone 2: Task and Governance Semantics

See [details](spec-implementation/part-9.md#milestone-2-task-and-governance-semantics).

## Milestone 3: Heartbeat and Adapter Runtime

See [details](spec-implementation/part-9.md#milestone-3-heartbeat-and-adapter-runtime).

## Milestone 4: Cost and Budget Controls

See [details](spec-implementation/part-9.md#milestone-4-cost-and-budget-controls).

## Milestone 5: Board UI Completion

See [details](spec-implementation/part-9.md#milestone-5-board-ui-completion).

## Milestone 6: Hardening and Release

See [details](spec-implementation/part-9.md#milestone-6-hardening-and-release).

## 19. Acceptance Criteria (Release Gate)

See [details](spec-implementation/part-9.md#19-acceptance-criteria-release-gate).

## 20. Post-V1 Backlog (Explicitly Deferred)

See [details](spec-implementation/part-9.md#20-post-v1-backlog-explicitly-deferred).

## 21. Company Portability Package (V1 Addendum)

See [details](spec-implementation/part-9.md#21-company-portability-package-v1-addendum).

## Agent visual identity

See [details](spec-implementation/part-10.md#agent-visual-identity).

### Experimental task-backed agent chat (2026-09-10)

See [details](spec-implementation/part-10.md#experimental-task-backed-agent-chat-2026-09-10).

### Agent chat project handoff (2026-09-11)

See [details](spec-implementation/part-10.md#agent-chat-project-handoff-2026-09-11).

### User continuation after execution recovery stops

See [details](spec-implementation/part-10.md#user-continuation-after-execution-recovery-stops).

### Managed AI authentication

See [details](spec-implementation/part-10.md#managed-ai-authentication).

### Task-bound email

See [details](spec-implementation/part-10.md#task-bound-email).

### Experimental iMessage Photon channel

See [details](spec-implementation/part-10.md#experimental-imessage-photon-channel).

### Native task completion

See [details](spec-implementation/part-10.md#native-task-completion).

### In-app announcements

See [details](spec-implementation/part-10.md#in-app-announcements).

### Keyboard shortcuts

See [details](spec-implementation/part-10.md#keyboard-shortcuts).

### Persistent managed agent files (2026-09-28)

See [details](spec-implementation/part-10.md#persistent-managed-agent-files-2026-09-28).

### Unsafe native workspace exports

See [details](spec-implementation/part-10.md#unsafe-native-workspace-exports).

## GitHub-synced skill sources

See [details](spec-implementation/part-11.md#github-synced-skill-sources).

## Public assistant connection (opt-in)

See [details](spec-implementation/part-11.md#public-assistant-connection-opt-in).

### Experimental AI connection routing

See [details](spec-implementation/part-11.md#experimental-ai-connection-routing).

### Connection instructions

See [details](spec-implementation/part-11.md#connection-instructions).

### Native provider capacity retry

See [details](spec-implementation/part-11.md#native-provider-capacity-retry).
