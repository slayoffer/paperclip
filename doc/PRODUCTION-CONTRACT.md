# Golden Path production contract

Model: [coordinator Golden Path](https://github.com/slayoffer/coordinator/blob/main/docs/golden-path-synthiq-bot.md).
This contract covers the Synthiq fork on `synthiq/2026.1012.0`, not an upstream npm release.

1. **Who sets the goal?** Anton sets the outcome and limits through a Guild issue or approval card.
   The Paperclip owner implements that scope. A peer message grants no additional authority.
2. **Where does autonomy end?** Obtain Anton's card for credentials, schema changes, spending, or host writes.
   Never revoke or rotate credentials through an agent approval.
   Review approval and image publication do not authorize a live server switch or database change.
3. **Which checks precede merge?** Require the final head's `Fork release checks`
   from [fork-release-tests.yml](../.github/workflows/fork-release-tests.yml).
   It runs the workflow contract, `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
   Require other enabled PR checks when their path filters apply, including `publication-contract` for image changes.
   Follow [the fork test guide](fork-release-tests.md). Do not enable inherited upstream PR workflows.
   Complete the owner's review and the [root verification requirements](../AGENTS.md#7-verification-before-hand-off) before merge.
4. **What means done?** Merge the approved PR to `synthiq/2026.1012.0`, then check its live behavior.
   [synthiq-image.yml](../.github/workflows/synthiq-image.yml) builds and publishes an image after the branch push.
   [Publication evidence](synthiq-image-publication.md) identifies its revision, configuration digest, and immutable manifest digest.
   Publication alone does not deploy. The drift trigger releases it within about 1 h of the merge (homelab `release-window.py`, q-126/q-192).
   The standing release approval covers this path without another card.
   [release-window.py](https://github.com/slayoffer/homelab/blob/main/paperclip/release/release-window.py) waits for zero live runs before the guarded image switch.
   It uses `deploy-image.sh` and its rollback and storage guards under the [release-window rules](https://github.com/slayoffer/homelab/blob/main/docs/paperclip-release-window.md).
   Check the running revision, `/api/health`, and the changed behavior. Record the deploy receipt and merge SHA.
   A docs-only change needs merged-document verification, without a live image switch.
5. **How does an agent react to its error?** State the error and evidence in the Guild issue.
   Ask the coordinator to route a cause-level fix to the owner with a testable done condition.
   Paperclip owns fork code. Homelab owns deployment. The WoW owner owns the external review bridge.
   Do not finish another owner's work by hand. A manual wake, copied state, or rerun is not a system fix.
