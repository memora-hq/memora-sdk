# Anthropic Receipt Example

This example records an Anthropic Messages API call inside `memora.receipt()` and prints the resulting Memora receipt fields plus follow-up CLI commands.

This example records the requested provider/model metadata and hashes the request/response. It does not prove the provider used that model unless the provider supplies a signed receipt or attestation.

## Install

From the repo root:

```bash
pnpm install
```

## Env Setup

```bash
cp examples/anthropic-receipt/.env.example examples/anthropic-receipt/.env
```

Set:

- `MEMORA_API_KEY`
- `MEMORA_AGENT_ID`
- `MEMORA_BASE_URL`
- `ANTHROPIC_API_KEY`
- optionally `ANTHROPIC_MODEL`
- optionally `ANTHROPIC_PROMPT`

## Run

From the repo root:

```bash
pnpm example:anthropic-receipt
```

Or from the example directory:

```bash
cd examples/anthropic-receipt
pnpm dev
```

## Expected Output

```text
Memora provider receipt example (Anthropic)
execution_id: 91388c5b-d09c-4036-b0f8-21c2555f67ae
event_digest: 8f8db6409f8a0a0feeb8e92ed8f3b8f4be2a4c0ec75c361c2c12059536f25d18
provider: anthropic
model: claude-3-5-sonnet-latest
input_hash: 55dc4ff3a4a445f8ac6dfef60bf00dcd9d43c2f8fd4b07a32d7dca09b8c82259
output_hash: b60293dd15e5df36f4b8c80586f6a741fd5fd14d2d6ad2cb1ec2216ee6eb8d2e

Provider response preview:
Execution receipts are verifiable records of an AI call...

Suggested CLI commands:
memora receipt 91388c5b-d09c-4036-b0f8-21c2555f67ae
memora verify 91388c5b-d09c-4036-b0f8-21c2555f67ae
```

## CLI Follow-Up

```bash
memora receipt <execution_id>
memora verify <execution_id>
```
