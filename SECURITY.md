# Security policy

## Scope

This policy covers `@memora-hq/memora-verifier`, `@memora-hq/memora-core`, and
`@memora-hq/memora-cli` — the offline verifier, client SDK, and CLI in this repository. It does
not cover Memora's hosted service (key custody, write authorization, service infrastructure,
that's `memora-cloud`) or live session capture (`memora-local`) — each has its own security
process.

## Supported versions

Developer preview. There are no versioned stable releases yet. Security reports should target
the current `main` branch and the latest published npm versions.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by emailing: **akuniyil@purdue.edu**

Include:
- A clear description of the vulnerability
- Steps to reproduce or a proof of concept
- The file(s) and function(s) involved
- Your assessment of impact and severity

You will receive an acknowledgement within 72 hours. Fixes are prioritized by severity. A
correctness bug in `packages/verifier` — what every offline verification of a `.memora` bundle
relies on — is treated as high severity by default.

## Known limitations

**A signature proves the record was not altered. It does not prove who produced it**, beyond
recovering a key. Matching that key to a real-world identity is outside what this package (or
any Memora verifier) establishes.

**`@memora-hq/memora-core` trusts the gateway it's pointed at.** The SDK itself does not verify
that a hosted deployment is honest — only that responses are internally consistent where
verification is possible offline (see `@memora-hq/memora-verifier` and `memora replay verify`
in the CLI for what's actually checked).
