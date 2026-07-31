import "dotenv/config";

import { Memora } from "@smritheon/memora-core";

type AnthropicResponse = {
  id: string;
  model: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<AnthropicResponse> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API request failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as AnthropicResponse;
}

function extractOutputText(result: AnthropicResponse): string {
  const text = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("")
    .trim();

  return text || "(no text output returned)";
}

async function main(): Promise<void> {
  const memora = new Memora({
    agentId: requiredEnv("MEMORA_AGENT_ID"),
    apiKey: requiredEnv("MEMORA_API_KEY"),
    baseUrl: process.env.MEMORA_BASE_URL,
  });

  const apiKey = requiredEnv("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
  const prompt = process.env.ANTHROPIC_PROMPT ?? "Explain execution receipts in one paragraph.";

  const requestInput = {
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  const { result, receipt } = await memora.receipt("ai.call", async () => {
    return await callAnthropic(apiKey, model, prompt);
  }, {
    provider: "anthropic",
    model,
    input: requestInput,
    metadata: {
      input_format: "messages_api",
      input_kind: "chat",
      input_length: prompt.length,
    },
  });

  console.log("Memora provider receipt example (Anthropic)");
  console.log(`execution_id: ${receipt.execution_id}`);
  console.log(`event_digest: ${receipt.event_digest ?? "(not returned)"}`);
  console.log(`provider: ${receipt.provider ?? "anthropic"}`);
  console.log(`model: ${receipt.model ?? model}`);
  console.log(`input_hash: ${receipt.input_hash ?? "(not recorded)"}`);
  console.log(`output_hash: ${receipt.output_hash}`);
  console.log("");
  console.log("Provider response preview:");
  console.log(extractOutputText(result));
  console.log("");
  console.log("Suggested CLI commands:");
  console.log(`memora receipt ${receipt.execution_id}`);
  console.log(`memora verify ${receipt.execution_id}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
