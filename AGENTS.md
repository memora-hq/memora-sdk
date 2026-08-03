# AGENTS.md — memora-sdk

Guidance for AI coding agents working in this repository. This repo is the public client-facing
half of a larger system; the hosted counterpart (indexer, key broker, console) lives in a
separate, closed-source repository (`memora-cloud`) and consumes `@memora-hq/memora-core` and
`@memora-hq/memora-protocol` the same way any other consumer does, from their published npm
versions.

## What's in here, and why the boundary is where it is

Three packages:

- `packages/verifier` (`@memora-hq/memora-verifier`) — offline verification of `.memora` bundles
  and on-disk local sessions: manifest signature, event-chain lineage, payload hashes. Zero
  network calls, zero native/OS-specific dependencies.
- `packages/sdk` (`@memora-hq/memora-core`) — the client SDK: `write`/`query`/`read`/`verify`
  against a Memora gateway (HTTP, `baseUrl` + `apiKey`).
- `packages/cli` (`@memora-hq/memora-cli`) — the `memora` binary, composing both of the above.

**Everything here must stay installable with zero native compilation.** A sibling repo,
`memora-local`, owns live session capture (`node-pty`-based terminal spawning), receipt HTML
rendering, and editor/agent hook integration (Claude Code, Codex, Cursor, VS Code) — all of
which depend on `@memora/local`. If you're tempted to import `@memora/local`, `node-pty`, or
`electron` from any package in this repo, stop: that code belongs in `memora-local`, not here.
`scripts/check-local-boundary.mjs` enforces this in CI (source-level import scan +
resolved-dependency-tree scan); it should always report 0 violations.

### Why the CLI is missing some commands you might expect

**`memora local <subcommand>` here means file/session operations on evidence already on
disk — never a local execution runtime.** This CLI does not, and will never, capture a live
session. Concretely: `local init`, `local sessions`, `local show`, `local verify`, `local
export`, and `local verify-bundle` all operate on data that already exists (an on-disk
session store or a `.memora` file someone handed you), so they only need
`@memora-hq/memora-verifier`. It does **not** support `local run` (spawns a PTY and records a
live session), `local receipt` (HTML rendering), `local hook`, or `local doctor` — those need
`@memora/local` and live in `memora-local`'s own CLI. Don't let a user's expectation that
`local run` exists here (it's a reasonable guess from the command family) turn into actually
adding it — that reintroduces the node-pty dependency this split exists to avoid. If you're
porting a change from the private monorepo's fuller CLI, check which side of that line it
falls on before assuming it belongs here.

A longer-term, clearer rename (not done now, to preserve compatibility) would be
`memora bundle verify` / `memora session show` / `memora session export` instead of
`memora local <subcommand>` — the `local` prefix on the surviving commands slightly
overloads with the *removed* `local run`'s meaning. Worth revisiting if the `local`
namespace's dual meaning causes real user confusion.

## Invariants — get these wrong and verification silently breaks

These are `@memora-hq/memora-protocol`'s invariants; this repo's packages don't reimplement
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

`@memora-hq/memora-verifier` exports `verifyBundle`/`verifySession` as the current names, with
`verifyLocalBundle`/`verifyLocalSession` kept as deprecated aliases of the same functions (for
callers that predate the extraction from `@memora/local`, e.g. `memora-local`'s own code). Use
the short names in anything new.

## Cross-repo dependency

`@memora-hq/memora-protocol` is a real npm dependency here, not a workspace link — this repo has
no `packages/protocol` directory. Bump the pinned version deliberately; don't assume `^` ranges
pick up prereleases (they don't, by semver's own rules) if the pin is currently a `-rc.N`
version.

**`@memora-hq/memora-core`'s `package.json` version must never regress to `0.2.1` or below.**
Real versions `0.1.0`/`0.2.0`/`0.2.1` are already live on npm, published before this repo (and
the protocol/verifier extraction) existed — `npm publish` rejects re-publishing an existing
version, and a prerelease of an *already-superseded* version (e.g. `0.1.0-rc.1`, published now)
would sort *older* than `0.2.1` and never become what `npm install` resolves to. The current
version here is `0.3.0-rc.1` for exactly this reason — check `npm view @memora-hq/memora-core
versions` before ever changing it, don't just increment blindly.

## What does NOT belong in this repo

Anything about: write authorization policy, key custody, Supabase/database schemas,
service-to-service authentication, rate limiting, or any hosted-service operational concern
(that's `memora-cloud`); live session capture, `node-pty`, receipt rendering, or editor/agent
hooks (that's `memora-local`).
