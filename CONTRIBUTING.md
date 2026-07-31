# Contributing

`memora-sdk` (`@smritheon/memora-verifier`, `@smritheon/memora-core`, `@smritheon/memora-cli`)
is an open-source developer preview under Apache 2.0. Contributions are welcome — bug fixes,
documentation improvements, and SDK/CLI ergonomics all help.

## Before you start

**Open an issue first for anything that touches `packages/verifier`'s verification logic** (bundle
parsing, session verification, signature/hash checks) — a bug there affects what every consumer
trusts. Small fixes (typos, broken links, non-normative doc corrections) can go straight to a PR.

**This repo does not accept changes to hosted infrastructure or to live session capture.** There
isn't any hosted infrastructure here, and live capture (`node-pty`, receipts, editor hooks)
lives in the separate `memora-local` repo. If your change needs either, it belongs in one of
those repos instead — see `AGENTS.md` for the exact boundary.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
pnpm run check:local-boundary
```

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make changes. Keep commits focused — one logical change per commit.
3. If your change touches `@smritheon/memora-protocol`'s version pin, update it deliberately in
   every package's `package.json` that depends on it, not just one.
4. Run `pnpm build && pnpm test && pnpm run check:local-boundary` locally before pushing. CI runs
   the same.
5. Open the PR against `main`.

## Code style

TypeScript throughout. No `any` without justification. No comments explaining *what* code does
— only *why*, when the reason is non-obvious.

## Sign-off

Commits should include a `Signed-off-by` line (`git commit -s`) certifying you wrote the change
or otherwise have the right to submit it under this project's license (Developer Certificate of
Origin).
