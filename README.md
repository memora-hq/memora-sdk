# memora-sdk

The client-facing half of [Memora](https://github.com/memora-hq): a CLI and SDK for producing
and verifying signed, hash-chained execution records.

**`memora-sdk` is this repo's name, not a package name — there is no `@smritheon/memora-sdk`
npm package.** Three separate packages live here, each with its own name and its own release:

| Package | Published as | What it is |
|---|---|---|
| [`packages/verifier`](./packages/verifier) | `@smritheon/memora-verifier` | Offline verification of `.memora` bundles and on-disk local sessions. No network, no native dependencies. |
| [`packages/sdk`](./packages/sdk) | `@smritheon/memora-core` | The client SDK: `write`/`query`/`read`/`verify` against a Memora gateway. Already published (0.1.0/0.2.0/0.2.1 predate this repo split) — this repo is its new source of truth going forward. |
| `packages/cli` | `@smritheon/memora-cli` | The `memora` command-line tool, built on both of the above. Not yet published (`private: true`). |

## Start here: verify a `.memora` bundle, offline

If someone hands you a `.memora` evidence bundle, you don't need an account, a network
connection, or to trust Memora's hosted service to check it's real:

```bash
npm install -g @smritheon/memora-cli   # not yet published — see AGENTS.md
memora local verify-bundle ./evidence.memora
```

This checks the manifest signature, event-chain lineage, and payload hashes entirely offline.
`@smritheon/memora-verifier` is the library behind this command — install it directly if you're
writing your own verifier instead of shelling out to the CLI.

## Then: talk to the hosted service

```bash
npm install @smritheon/memora-core
```

```typescript
import { MemoraClient } from "@smritheon/memora-core";

const client = new MemoraClient({ baseUrl: "https://api.getmemora.dev", apiKey: "..." });
const receipt = await client.write({ agentId: "my-agent", content: { ... } });
```

See [`packages/sdk/README.md`](./packages/sdk/SPEC.md) for the full API.

## What's not in this repo

Live session capture (`memora local run`, spawning a PTY and recording an agent's actual
terminal session), receipt HTML rendering, and editor/agent hook integration (Claude Code,
Codex, Cursor, VS Code) all depend on `@memora/local` and, transitively, `node-pty` — a native
addon. That code lives in a separate `memora-local` repo so that installing this repo's
packages never triggers native compilation. See
[`packages/verifier/README.md`](./packages/verifier/README.md#whats-deliberately-not-here).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm run check:local-boundary   # proves no package here depends on node-pty/Electron/local
```

## Versioning

Each package here follows independent semver, pinned against a specific
`@smritheon/memora-protocol` release (see that package's own versioning rules — a signing
digest or wire-format change there is always a major version). This repo does not use a single
shared version number across its three packages.

## License

Apache-2.0
