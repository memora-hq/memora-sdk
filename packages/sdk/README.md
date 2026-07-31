# @smritheon/memora-core

**Package:** [npmjs.com/package/@smritheon/memora-core](https://www.npmjs.com/package/@smritheon/memora-core)

**Memora SDK** — add verifiable execution provenance to existing workflows without rewriting them. Works beside Temporal, LangGraph, CrewAI, Dapr, and custom agent runtimes. Does not replace orchestration.

**Documentation**

- Hosted console docs: [getmemora.dev/docs](https://getmemora.dev/docs)
- Full SDK reference: [SPEC.md](./SPEC.md)

---

## Install

```bash
npm install @smritheon/memora-core
# or
pnpm add @smritheon/memora-core
```

---

## Quickstart (hosted)

Get a per-agent API key from [getmemora.dev](https://getmemora.dev) → Identities → Credentials.

```typescript
import { Memora } from "@smritheon/memora-core";

const memora = new Memora({
  agentId: process.env.MEMORA_AGENT_ID!, // from console
  apiKey:  process.env.MEMORA_API_KEY!,  // per-agent key from console
  // Self-hosted: add baseUrl: process.env.MEMORA_BASE_URL  // e.g. https://api.your-domain.com
});

const result = await memora.trace("my-run", async (trace) => {
  await trace.event("task_started", { ts: Date.now() });
  const output = await yourExistingWorkflow();
  await trace.event("task_completed", { status: "success" });
  return output;
});
```

---

## Add Memora without rewriting your workflow

```typescript
// Drop-in wrapper — call site unchanged
const analyseRisk = memora.wrap("risk-analysis", existingAnalyser);
const result = await analyseRisk(portfolio);

// Custom event granularity
const decision = await memora.trace("treasury-rebalance", async (trace) => {
  await trace.event("input_received", { input });
  const outcome = await existingWorkflow(input);
  await trace.event("decision_made", { outcome });
  return outcome;
});

// Tool calls with input/output hashing
const transfer = memora.tool("transfer_funds", async (args) => bankTransfer(args));
const receipt = await transfer({ amount: 100, to: "0x..." });
```

### Memora Receipts

Record an AI/API call as a verifiable execution receipt (single `ai_receipt` event):

```typescript
const { result, receipt } = await memora.receipt(async () => {
  return await client.responses.create({
    model: "gpt-4.1",
    input: "Explain execution receipts",
  });
}, {
  provider: "openai",
  model: "gpt-4.1",
  input: { input: "Explain execution receipts" },
});

console.log(receipt.execution_id);
console.log(receipt.event_digest);
```

Named execution variant:

```typescript
const { result, receipt } = await memora.receipt("ai.call", async () => {
  return await anthropic.messages.create({
    model: "claude-opus-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
  });
}, {
  provider: "anthropic",
  model: "claude-opus-4-20250514",
  input: { messages: [{ role: "user", content: "Hello" }] },
});
```

Receipts record request/response hashes and integrator-supplied metadata into Memora's verifiable execution stack. They do **not** prove a closed AI provider used a specific model unless the provider co-signs or attests.

### OpenTelemetry bridge

The optional bridge maps selected completed spans into Memora evidence events without replacing your OTLP exporter:

```typescript
import { createMemoraSpanProcessor } from "@smritheon/memora-core/opentelemetry";

const memoraProcessor = createMemoraSpanProcessor({
  memora,
  attributeAllowlist: ["http.request.method", "service.name"],
});
```

Add the processor to your OpenTelemetry tracer provider. Attributes are excluded unless allowlisted, and the bounded queue can report dropped spans through `onDrop`.

### Integration API


| Method                    | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `memora.receipt(fn, opts?)` | Record an AI/API execution as a verifiable receipt with input/output hashes.      |
| `memora.receipt(name, fn, opts?)` | Same, with a named execution label (`ai.call`, etc.).                        |
| `memora.trace(runId, fn)` | Wrap any function in a traced run. Explicit event granularity via `trace.event()`. |
| `memora.wrap(name, fn)`   | Drop-in wrapper. Records start/complete/failed automatically.                      |
| `memora.tool(name, fn)`   | Tool call wrapper. Records input hash, output hash, duration.                      |


---

## Memora is not an orchestrator

Memora adds provenance, replay, and attestation to whatever you already run. It does not manage retries, state, or scheduling.


| Your stack                  | Memora adds            |
| --------------------------- | ---------------------- |
| Temporal / LangGraph / Dapr | Execution provenance   |
| Custom agent runtime        | Signed event lineage   |
| Any async TypeScript        | Replayable audit trail |


---

## Configuration

| Option | Required | Description |
|--------|----------|-------------|
| `agentId` | Yes | Agent UUID from web console |
| `apiKey` | Yes (writes) | Per-agent key → `Authorization: Bearer` |
| `baseUrl` | No | Memora API URL — defaults to `https://api.getmemora.dev` for hosted |
| `ipfsGatewayUrl` | No | IPFS gateway for decrypting stored payloads (optional) |

Deprecated `MemoraConfig.mode` and `MemoraConfig.backend` are ignored. Integrity and provenance policy are set in the web console, not the SDK.

For low-level `write` / `query` / `read` / `verify`, use `memora.client` or see [SPEC.md](./SPEC.md).

---

## Deployment policy (console + indexer)

**Provenance backend** and **integrity mode** are configured in the web console — not in the SDK.


| Setting            | Where                       | Values                             |
| ------------------ | --------------------------- | ---------------------------------- |
| Provenance backend | Workspace → Settings        | `enterprise` or `hedera`           |
| Integrity mode     | Agent detail → Write policy | `standard`, `attested`, `verified` |


The SDK sends writes; the indexer enforces policy. See [SPEC.md](./SPEC.md) for write/query/read/verify details.

---

## Replay

Verify any execution record with the Memora CLI:

```bash
pnpm --filter @memora/cli -- replay verify --memory <event_id>
```

---

## Self-hosting

Deploy Memora from the [memora repository](https://github.com/Akk525/memora):

- [docs/LOCAL_SETUP.md](https://github.com/Akk525/memora/blob/main/docs/LOCAL_SETUP.md)
- [docs/RAILWAY.md](https://github.com/Akk525/memora/blob/main/docs/RAILWAY.md)

Point the SDK at your deployment:

```typescript
const memora = new Memora({
  agentId: process.env.MEMORA_AGENT_ID!,
  apiKey:  process.env.MEMORA_API_KEY!,
  baseUrl: "https://api.your-domain.com",
});
```

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) and the [memora repository](https://github.com/Akk525/memora/blob/main/LICENSE).
