# Pinned Pi distribution inputs

This directory is an isolated npm distribution, not a host workspace package.
The materializer copies `package.json` into the runtime and hashes its bytes
into `PI_DISTRIBUTION_CLOSURE_SHA256`, together with the installed payload.

Do not apply repository-wide Node engine rewrites to this manifest. Its engine
metadata must match the committed npm lock. The executable comes from
`../../src/drivers/acpx/pi-node-pins.ts`, with its own release checksum.
Host Node requirements do not select that executable.

Measured on 2026-11-08: changing only `engines.node` from `>=24.11.0` to
`>=24.22.1` caused the provider-pack build to fail its native closure check.
Keep the exact-path exception in `scripts/check-node-version-policy.mjs`.
Changing this distribution requires qualification of the complete closure.
