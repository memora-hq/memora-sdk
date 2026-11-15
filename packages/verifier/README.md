# @memora-hq/memora-verifier

Offline verification for Memora local evidence — `.memora` bundles and on-disk local session
stores. No network calls, no hosted service, no native or OS-specific dependencies.

This package answers: **given evidence produced on a machine (a bundle someone exported, or a
session recorded on disk), is it internally consistent?** Signature recovery, event-chain
lineage, payload hashes, and manifest continuity all get checked here, entirely offline.

```bash
npm install @memora-hq/memora-verifier
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

## Original hosted event bytes

The package also re-exports protocol `verifyOriginalEvent`, `verifyProfiledEvent`,
`verifyProfiledEventId` and `EVENT_ID_PROFILES`. These additive pure checks do not
turn a hosted original into a Local session or bundle. Existing Local verification
remains shared-profile only. No hosted storage-wrapper observations are trusted.

```ts
const result = verifyOriginalEvent(original, {
  profile: EVENT_ID_PROFILES.hosted, // from your verification policy
  expectedOperatorSigner: trustedOperatorAddress, // pinned outside the artifact
});
```

This verifies the ID/preimage/operator statement, not agent signer governance,
plaintext, tenant authorization, unsigned wrapper metadata, or TEE authenticity.
Missing historical original signatures remain unavailable proof. Never obtain the
expected operator from the artifact's own claimed signer.

HCS CLI replay defaults to the hosted profile. To inspect explicitly known shared
HCS records, use `--event-id-profile shared-protocol-json-stringify-v1` with
`--signer`; there is no automatic fallback. This flag does not change Local bundle
verification. Unknown profile values are rejected before replay.
