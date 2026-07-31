# AGENTS.md — memora-sdk

Guidance for AI coding agents working in this repository. This repo is the public client-facing
half of a larger system; the hosted counterpart (indexer, key broker, console) lives in a
separate, closed-source repository (`memora-cloud`) and consumes `@smritheon/memora-core` and
`@smritheon/memora-protocol` the same way any other consumer does, from their published npm
versions.

## What's in here, and why the boundary is where it is

Three packages:

- `packages/verifier` (`@smritheon/memora-verifier`) — offline verification of `.memora` bundles
  and on-disk local sessions: manifest signature, event-chain lineage, payload hashes. Zero
  network calls, zero native/OS-specific dependencies.
- `packages/sdk` (`@smritheon/memora-core`) — the client SDK: `write`/`query`/`read`/`verify`
  against a Memora gateway (HTTP, `baseUrl` + `apiKey`).
- `packages/cli` (`@smritheon/memora-cli`) — the `memora` binary, composing both of the above.

**Everything here must stay installable with zero native compilation.** A sibling repo,
`memora-local`, owns live session capture (`node-pty`-based terminal spawning), receipt HTML
rendering, and editor/agent hook integration (Claude Code, Codex, Cursor, VS Code) — all of
which depend on `@memora/local`. If you're tempted to import `@memora/local`, `node-pty`, or
`electron` from any package in this repo, stop: that code belongs in `memora-local`, not here.
`scripts/check-local-boundary.mjs` enforces this in CI (source-level import scan +
resolved-dependency-tree scan); it should always report 0 violations.

### Why the CLI is missing some commands you might expect

The CLI in this repo supports `local init`, `local sessions`, `local show`, `local verify`,
`local export`, and `local verify-bundle` — everything that only needs
`@smritheon/memora-verifier`. It does **not** support `local run` (live capture), `local
receipt` (HTML rendering), `local hook`, or `local doctor` — those need `@memora/local` and
live in `memora-local`'s own CLI. If you're porting a change from the private monorepo's fuller
CLI, check which side of that line it falls on before assuming it belongs here.

## Invariants — get these wrong and verification silently breaks

These are `@smritheon/memora-protocol`'s invariants; this repo's packages don't reimplement
them, but do rely on getting them right by construction, so anyone changing signing/verification
code here should know them:

1. **`agentId` has two encodings.** Off-chain (everything in this repo) uses the raw UTF-8
   string; on-chain uses `ethers.keccak256(ethers.toUtf8Bytes(agentId))`. Never mix them up when
   code here talks to a contract.
2. **Sign raw digest bytes, not their hex string.** `wallet.signMessage(getBytes(digestHex))`,
   never `wallet.signMessage(digestHex)`.
3. **`event_id` is computed with `signature: null`, before signing.** Reversing this order
   produces an `event_id` that doesn't match what was signed.
4. **Parent event IDs are sorted before signing** — protocol's digest functions do this
   internally; don't rely on insertion order if constructing one manually.
5. **Signing JSON is canonical and version-sensitive.** Any change to a signed field's shape is
   effectively a protocol version bump, not a local decision — see `memora-protocol`'s AGENTS.md.

## Naming note: `verifyBundle`/`verifySession` vs. the `Local*` names

`@smritheon/memora-verifier` exports `verifyBundle`/`verifySession` as the current names, with
`verifyLocalBundle`/`verifyLocalSession` kept as deprecated aliases of the same functions (for
callers that predate the extraction from `@memora/local`, e.g. `memora-local`'s own code). Use
the short names in anything new.

## Cross-repo dependency

`@smritheon/memora-protocol` is a real npm dependency here, not a workspace link — this repo has
no `packages/protocol` directory. Bump the pinned version deliberately; don't assume `^` ranges
pick up prereleases (they don't, by semver's own rules) if the pin is currently a `-rc.N`
version.

## What does NOT belong in this repo

Anything about: write authorization policy, key custody, Supabase/database schemas,
service-to-service authentication, rate limiting, or any hosted-service operational concern
(that's `memora-cloud`); live session capture, `node-pty`, receipt rendering, or editor/agent
hooks (that's `memora-local`).
