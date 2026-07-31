# Memora Core Protocol Specification — v0.1 (frozen)

Verifiable long-term memory for AI agents. This document defines the **v0.1** protocol. Implementations must follow these schemas and rules for interoperability.

---

## 1. MemoryPayload (plaintext)

Plaintext JSON before encryption. Canonicalized for deterministic hashing.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `memora_version` | string | Yes | Protocol version, e.g. `"0.1"`. |
| `contentType` | string | Yes | MIME type (e.g. `application/json`). |
| `content` | unknown | Yes | Opaque payload (object, string, etc.). |
| `schemaVersion` | number | Yes | Internal schema version (e.g. `1`), included in canonical form. |
| `tags` | string[] | No | Sorted for canonical form. |
| `taskId` | string | No | Optional task scope. |
| `access` | AccessPolicySummary | No | Owner, delegates, mode (discovery). |
| `meta` | Record<string, unknown> | No | Included in canonical bytes for hashing. |

**Example MemoryPayload (plaintext):**

```json
{
  "memora_version": "0.1",
  "contentType": "application/json",
  "content": { "summary": "Standup notes", "decisions": ["Use Memora"] },
  "schemaVersion": 1,
  "tags": ["meeting", "standup"]
}
```

---

## 2. EncryptedPayloadBundle (storage)

Exact JSON shape stored as the ciphertext blob. Key is never on-chain. Default storage is **Supabase Storage** (`storage_provider: "supabase"`); IPFS/Pinata is optional (`storage_provider: "ipfs"`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `v` or `version` | number | Yes | Bundle format version (e.g. `1`). |
| `alg` | string | Yes | `"AES-256-GCM"`. |
| `nonce` | string | Yes | Base64-encoded 12-byte IV. |
| `ciphertext` | string | Yes | Base64-encoded ciphertext. |
| `tag` | string | Yes | Base64-encoded 16-byte GCM auth tag. |
| `aad` | string | No | Additional authenticated data (base64); optional, for future use. |

**Example EncryptedPayloadBundle (values are illustrative):**

```json
{
  "version": 1,
  "alg": "AES-256-GCM",
  "nonce": "dGVzdC1ub25jZS0xMg==",
  "ciphertext": "bG9uZyBiYXNlNjQgY2lwaGVydGV4dC4uLg==",
  "tag": "YXV0aC10YWctMTYtYnl0ZXM="
}
```

---

## 3. MemoryCommit (HCS message)

Exact schema of the message published to the Hedera Consensus Service topic (canonical ordering).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `memory_id` | string | Yes | bytes32 hex (derived from payload_hash + cid + timestamp). |
| `agent_id` | string | Yes | Agent identifier. |
| `task_id` | string | No | Optional task scope. |
| `cid_ciphertext` | string | Yes | IPFS CID of the encrypted bundle. |
| `payload_hash` | string | Yes | SHA-256 hex of canonical plaintext (see §4). |
| `schema_version` | number | Yes | Protocol schema version (e.g. `1`). |
| `access_policy_summary` | object | No | Owner, delegates, mode (discovery only). |

**Example MemoryCommit (HCS message):**

```json
{
  "memory_id": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "agent_id": "my-agent",
  "cid_ciphertext": "QmPhJ243JDyt1wAt3LXixwhXZ3d2Z2RVseRsDPGJCBoNYg",
  "payload_hash": "0xa7cb26bb7d95a4d4bc56ec6ee505e44b8a1a95b3886d07394fe8152de6a46497",
  "schema_version": 1
}
```

---

## 4. Hashing and canonicalization

- **Deterministic JSON**: Canonical form uses sorted keys, no extra whitespace, consistent number/string encoding (RFC 8785 style).
- **Order of operations**: Payload → canonicalize → **hash canonical string** → encrypt canonical string. The **payload_hash** is computed on the canonical plaintext bytes **before** encryption.
- **Same input, same hash**: The same MemoryPayload must produce the same hash on all machines.
- **Hash algorithm**: SHA-256 of the UTF-8 canonical string; stored as hex (with or without `0x` prefix; comparison strips prefix).

---

## 5. Verification flow

1. **Fetch ref** from indexer or gateway (`GET /memory/:memory_id` or `GET /v1/events/:id`).
2. **Fetch ciphertext** by `storage_provider`:
   - `supabase` — `GET ref.storage_uri` (public encrypted blob URL).
   - `ipfs` or legacy — IPFS gateway + `cid_ciphertext`.
3. **Request key** from key broker (challenge → sign → POST `/keys` or `/v1/keys/release`).
4. **Decrypt** bundle with key to get canonical plaintext.
5. **Recompute hash** of canonical plaintext (SHA-256 hex).
6. **Compare** to `ref.payload_hash` (strip `0x` if present). Mismatch ⇒ tampered or corrupted.

---

## 6. Access control model

- **Owner**: The EVM address that registered the agent (registry). Owner can write memories, add/revoke delegates, and read (via key broker).
- **Delegates**: Addresses set via `setDelegate(agentId, delegateAddr, true)`. Delegates can read (key broker releases key); they cannot write unless also given write rights by the indexer/contract.
- **Task participants / shared memory**: Not part of v0.1; reserved for future roadmap.

---

## 7. External service expectations

### Gateway API (recommended public surface)

SDK consumers should use a **single gateway `baseUrl`** with `v1Routes: true`. Internal indexer and key-broker URLs are not exposed to clients.

| Method | Endpoint | Proxies to |
|--------|----------|------------|
| POST | `/v1/events` | `POST {INDEXER}/write` |
| GET | `/v1/events?agent_id=...` | `GET {INDEXER}/memories` |
| GET | `/v1/events/:id` | `GET {INDEXER}/memory/:id` |
| POST | `/v1/batches/flush` | `POST {INDEXER}/batch/flush` |
| GET | `/v1/keys/challenge?memory_id=...&requester=...` | `GET {KEY_BROKER}/challenge` |
| POST | `/v1/keys/release` | `POST {KEY_BROKER}/keys` |
| GET | `/v1/health` | Aggregated health (indexer + key-broker) |

Hosted example: `https://api.getmemora.dev`

Writes require `Authorization: Bearer <per-agent-api-key>` (issued in the web console).

### Indexer API (internal / direct mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/memories?agent_id=...&limit=&offset=&task_id=&order_by=` | List memory refs. `order_by=hcs_sequence` for HCS order. |
| GET | `/memory/:memory_id` | Single memory ref. |
| POST | `/write` | Body: `{ payload, agent_id, task_id? }`. Returns write receipt. |
| GET | `/health` | Service health + batcher/integrity status. |

### Key Broker API (internal / direct mode)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/challenge?memory_id=...&requester=...` | Returns `{ nonce, message }`. Requester signs `message`. |
| POST | `/keys` | Body: `{ memory_id, requester, signature, challenge }`. Returns `{ key }` (base64) if owner or delegate; else 403. |
| GET | `/health` | Service health. |

---

## Summary

- **MemoryPayload** → canonicalize → **payload_hash** → encrypt → storage (Supabase or IPFS) → **MemoryCommit** (HCS) + contract + key stored at key broker.
- **SDK** → gateway (`/v1/*`) → indexer + key-broker (production). Direct indexer URLs for local dev only.
- Readers: ref → ciphertext (storage URI or IPFS) → key (challenge/sign) → decrypt → verify hash.

---

## Implemented in v0.1

- MemoryPayload, EncryptedPayloadBundle, MemoryCommit schemas above.
- Hashing and canonicalization (deterministic; hash before encrypt).
- Verification flow (ref → IPFS → key → decrypt → hash compare).
- Access control: owner and delegates (on-chain registry).
- Indexer and Key Broker APIs as specified.
- Local development: indexer, key-broker, SDK, CLI, proof/demo scripts.

## Future (not v0.1)

- Task participants; shared memory mode.
- Skill capsules; marketplace; token-gated key release.
- External KMS for `MEMORA_KEK` (env-var KEK today).

---

# Memora v0.2 — Execution lineage (additive)

v0.2 extends the protocol with **execution lineage** so memories can be nodes in a verifiable graph (parent/child, mission context, event type, derivation). v0.1 remains valid; all new fields are optional.

## Why lineage

- **Replay**: Order memories by `mission_id` and `parent_ids` to reconstruct an execution.
- **Provenance**: `derived_from` links outputs to inputs; `tool_ref` identifies the producer.
- **Mission coordination**: Group related steps with `mission_id`.
- **Future**: Experience capsules and higher-order artifacts can reference `capsule_id`.

## MemoryPayload v0.2 (optional fields)

| Field | Type | Description |
|-------|------|-------------|
| `memora_version` | string | Use `"0.2"` for lineage-enabled writes; omit or `"0.1"` for flat. |
| `event_type` | string | e.g. `task_started`, `tool_called`, `tool_result`, `reasoning_summary`, `memory_written`, `task_completed`, `capsule_created`. |
| `mission_id` | string | Mission or run identifier. |
| `parent_ids` | string[] | Immediate parent memory IDs (prior steps). |
| `derived_from` | string[] | Memory or artifact IDs this payload derives from. |
| `tool_ref` | string | Name/ID of tool or runtime. |
| `capsule_id` | string | Future: link to experience capsule. |
| `actor_type` | `"agent" \| "user" \| "system"` | Who produced this memory. |
| `actor_id` | string | Actor identifier (e.g. agent_id or wallet). |

**parent_ids vs derived_from**: `parent_ids` are immediate prior steps in the same execution chain (e.g. previous memory in the mission). `derived_from` is broader provenance (e.g. inputs or artifacts this memory was computed from).

## MemoryCommit v0.2 (summary only on HCS)

To avoid bloating the HCS message, only a minimal summary is added to the commit:

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | Same as payload. |
| `mission_id` | string | Same as payload. |
| `parent_count` | number | Length of `parent_ids`. |
| `derived_from_count` | number | Length of `derived_from`. |

Full lineage (including `parent_ids`, `derived_from`) lives in the encrypted payload and is persisted by the indexer from the write path.

## Backward compatibility

- Payloads without any lineage fields are treated as v0.1; canonicalization defaults `memora_version` to `"0.1"` so hashes stay unchanged.
- Indexer and SDK accept both v0.1 and v0.2; lineage columns are nullable.
- Old memories continue to verify and query as before.

## Example: mission execution chain

| Step | event_type | mission_id | parent_ids | content |
|------|------------|------------|------------|---------|
| 1 | task_started | mission-1 | [] | { "note": "Started" } |
| 2 | tool_called | mission-1 | [id1] | { "tool": "search" } |
| 3 | tool_result | mission-1 | [id2] | { "result": "…" } |
| 4 | reasoning_summary | mission-1 | [id3] | { "summary": "…" } |
| 5 | task_completed | mission-1 | [id4] | { "status": "success" } |

Each step’s `parent_ids` points to the previous step’s `memory_id`. Query by `mission_id` and order by `hcs_sequence` to get the timeline.

## OpenTelemetry span bridge

The optional `@smritheon/memora-core/opentelemetry` entry point provides a bounded `SpanProcessor`. It maps completed spans to `otel_span` events, copies only allowlisted attributes, preserves parent lineage when available, and reports queue/write drops through `onDrop`. It is not an OTLP collector and does not replace an observability backend.
