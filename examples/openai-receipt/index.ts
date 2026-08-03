import "dotenv/config";

import { Memora } from "@memora-hq/memora-core";

type OpenAIResponse = {
  id: string;
  model: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function callOpenAI(apiKey: string, model: string, input: string): Promise<OpenAIResponse> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API request failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as OpenAIResponse;
}

function extractOutputText(result: OpenAIResponse): string {
  const text = result.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" || item.type === "text")
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

  const apiKey = requiredEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const prompt = process.env.OPENAI_PROMPT ?? "Explain execution receipts in one paragraph.";

  const requestInput = {
    input: prompt,
  };

  const { result, receipt } = await memora.receipt("ai.call", async () => {
    return await callOpenAI(apiKey, model, prompt);
  }, {
    provider: "openai",
    model,
    input: requestInput,
    metadata: {
      input_format: "responses_api",
      input_kind: "text",
      input_length: prompt.length,
    },
  });

  console.log("Memora provider receipt example (OpenAI)");
  console.log(`execution_id: ${receipt.execution_id}`);
  console.log(`event_digest: ${receipt.event_digest ?? "(not returned)"}`);
  console.log(`provider: ${receipt.provider ?? "openai"}`);
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
