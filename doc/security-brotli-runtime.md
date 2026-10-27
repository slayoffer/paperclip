# Brotli runtime update

This change applies the CVE-2026-111497 inventory proposal.
The Node baseline is 24.22.1.
Docker bases use the supplied immutable digests.
The package engines, CI versions, installer minimum, and portable fallback agree.

System Brotli libraries require separate packages:

| Image stage | Required package |
| --- | --- |
| Debian 13 production | `libbrotli1=1.1.0-2+deb13u1` |
| Ubuntu 22.04 agent runtime | `libbrotli1=1.0.9-2ubuntu0.1` |
| Ubuntu 24.04 onboard smoke | `libbrotli1=1.1.0-2ubuntu0.1` |

The NodeSource stages install `nodejs=24.22.1-1nodesource1`.
Python interpreter versions do not prove the status of installed Brotli wheels.

The owner must complete these steps after review:

1. Run the full typecheck, test suite, and application build.
2. Build the production, smoke, Daytona, and agent-runtime images.
3. Test package availability and application compatibility in those images.
4. Rebuild all derived agent-runtime images and record their new digests.
5. Check the inherited Daytona sandbox and Cloudflare sandbox separately.
6. Test the Brotli decoder and system library in each rebuilt image.
7. Deploy approved image digests through the normal owner procedure.

The supplied inventory reports that the live Paperclip decoder already passes.
This task does not repeat that live check or change a running container.
The Cloudflare base has no verified Brotli status in the supplied inventory.

Five existing workflow files exceed the local size limit.
Their explicit `.file-size-ignore` entries preserve their jobs during this pin update.
The pnpm lockfile stays unchanged under the repository lockfile policy.
