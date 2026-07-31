# OpenAI Receipt Example

This example records an OpenAI Responses API call inside `memora.receipt()` and prints the resulting Memora receipt fields plus follow-up CLI commands.

This example records the requested provider/model metadata and hashes the request/response. It does not prove the provider used that model unless the provider supplies a signed receipt or attestation.

## Install

From the repo root:

```bash
pnpm install
```

## Env Setup

```bash
cp examples/openai-receipt/.env.example examples/openai-receipt/.env
```

Set:

- `MEMORA_API_KEY`
- `MEMORA_AGENT_ID`
- `MEMORA_BASE_URL`
- `OPENAI_API_KEY`
- optionally `OPENAI_MODEL`
- optionally `OPENAI_PROMPT`

## Run

From the repo root:

```bash
pnpm example:openai-receipt
```

Or from the example directory:

```bash
cd examples/openai-receipt
pnpm dev
```

## Expected Output

```text
Memora provider receipt example (OpenAI)
execution_id: 7d51f39d-6ac4-4d1f-9e35-2bd7f5e4f6d2
event_digest: 4a5e0f1f0e7c9d7d9f4c62f8b4ddf0e0d72cbbdbf39e8f85f6b90e5a0a8f4a27
provider: openai
model: gpt-4.1-mini
input_hash: 6d8b2a9d8d8bb14a7d3c21b5fa9b255f0d1d65df0e23f3d31f03f220762f1b14
output_hash: 967d1b2c14a7b7d68cf2d4501571a575c5f2c0fd57e34d0a34fb7fd3fe8f37fa

Provider response preview:
Execution receipts are verifiable records of an AI call...

Suggested CLI commands:
memora receipt 7d51f39d-6ac4-4d1f-9e35-2bd7f5e4f6d2
memora verify 7d51f39d-6ac4-4d1f-9e35-2bd7f5e4f6d2
```

## CLI Follow-Up

```bash
memora receipt <execution_id>
memora verify <execution_id>
```
