# Execution-target SSH retries

The shared SSH command runner retries transport failures up to three times.
It waits one second before the second attempt and two seconds before the third.
SSH exit 255, connection timeout, connection reset, connection refusal, and
key-exchange failures are transport failures. A completed remote command's
nonzero exit is not retried, including exit 255.

Set `PAPERCLIP_SSH_CONNECT_TIMEOUT_SEC` on the Paperclip server to change the
connection timeout. The default is 30 seconds. Positive integer values are
capped at 60 seconds. Invalid values use the default. All SSH arguments created
by `createSshAuthArgs`, including provider launches and transfers, use this setting.

Each command attempt permits at least the connection timeout plus five seconds.
The retry deadline is 120 seconds, or the explicit command timeout if that is
longer. Environment transfer and cleanup share the attempt deadline.
The stdin process path permits up to five additional seconds for forced shutdown.
An expired connection deadline remains a transport error. A timeout after the
remote shell starts remains a command timeout.

The Git-context probe preserves exhausted transport errors. Before provider
execution, the server cancels that invocation as an expected resource wait.
It schedules another run after 30 seconds, with exponential delay capped at
five minutes. The scheduled run inherits the existing failure-retry accounting.
Transport waits do not spend that budget or block the issue. Normal dispatch
gates still apply, including cancellation, ownership, pause, and budget checks.
An existing workspace-restore or restart-reconciliation hold still applies.

This change does not alter SSH credentials, host-key checks, or deployment.
Validation under load on home-pc belongs to homelab after merge.
