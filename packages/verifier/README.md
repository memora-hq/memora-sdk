# @smritheon/memora-verifier

Offline verification for Memora local evidence — `.memora` bundles and on-disk local session
stores. No network calls, no hosted service, no native or OS-specific dependencies.

This package answers: **given evidence produced on a machine (a bundle someone exported, or a
session recorded on disk), is it internally consistent?** Signature recovery, event-chain
lineage, payload hashes, and manifest continuity all get checked here, entirely offline.

```bash
npm install @smritheon/memora-verifier
```

## What's in here

| Module | Purpose |
|---|---|
| `bundle.ts` | Read, export, and verify `.memora` evidence bundles (`verifyBundle`, `readLocalBundle`, `exportLocalBundle`) |
| `verify.ts` | Verify an on-disk local session store end-to-end (`verifySession`) |
| `store.ts` | `LocalEvidenceStore` — the on-disk layout a session is read from |
| `session.ts` | `LocalSession` and encryption-key derivation for a session |
| `manifest.ts` | Sign and verify a session's execution manifest |
| `identity.ts` | Local signing identity (an Ethereum-style keypair) and its on-disk key file |

## Who uses this

- [`memora-sdk`](https://github.com/memora-hq/memora-sdk) — the CLI's offline `.memora` bundle
  verifier (tier 1 of the two-tier verification story: offline first, API-backed second).
- `memora-local` — the desktop app's capture engine, for reading back and verifying what it
  just recorded. Capturing itself (spawning a PTY, watching the filesystem) is **not** in this
  package — see "What's deliberately not here" below.

## What's deliberately not here

This package verifies evidence; it does not produce it. Nothing here spawns a process, opens a
pseudo-terminal, or touches Electron. If you're looking for live session capture
(`runLocalCommand` and friends), that lives in `memora-local`, which depends on this package —
never the other way around.

## Naming note

`verifyBundle`/`verifySession` are the current names. `verifyLocalBundle`/`verifyLocalSession`
are kept as deprecated aliases of the same functions for existing callers; new code should use
the short names.

## License

Apache-2.0
