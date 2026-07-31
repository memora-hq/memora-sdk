/**
 * Tests for the Memora integration layer (Memora class).
 *
 * All tests mock `fetch` globally — no live Hedera, Supabase, or IPFS required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Memora, MEMORA_HOSTED_BASE_URL } from "./tracer.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

let _counter = 0;

function makeWriteResponse(id?: string, eventId?: string) {
  return {
    memory_id: id ?? `mem_${++_counter}`,
    ...(eventId !== undefined && { event_id: eventId }),
    cid_ciphertext: "QmMockCID",
    payload_hash: "deadbeef",
    hcs_topic_id: "0.0.99999",
    contract_tx_hash: "0xdeadbeef",
  };
}

interface CapturedCall {
  url: string;
  eventType: string;
  missionId: string;
  parentIds: string[];
  content: Record<string, unknown>;
  meta: Record<string, unknown>;
  returnedId: string;
}

function installFetchMock(opts?: { eventId?: string }): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        payload?: {
          event_type?: string;
          mission_id?: string;
          parent_ids?: string[];
          content?: Record<string, unknown>;
          meta?: Record<string, unknown>;
        };
      };
      const id = `mem_${++_counter}`;
      calls.push({
        url: String(url),
        eventType: body.payload?.event_type ?? "",
        missionId: body.payload?.mission_id ?? "",
        parentIds: body.payload?.parent_ids ?? [],
        content: (body.payload?.content ?? {}) as Record<string, unknown>,
        meta: (body.payload?.meta ?? {}) as Record<string, unknown>,
        returnedId: id,
      });
      const eventId = opts?.eventId ?? "a".repeat(64);
      return { ok: true, json: async () => makeWriteResponse(id, eventId) } as Response;
    })
  );
  return { calls };
}

const BASE_CONFIG = {
  agentId: "test-agent",
  apiKey: "test-key",
  endpoint: "http://localhost:3001",
};

// ─── trace() ─────────────────────────────────────────────────────────────────

describe("Memora.trace()", () => {
  let memora: Memora;
  let calls: CapturedCall[];

  beforeEach(() => {
    _counter = 0;
    memora = new Memora(BASE_CONFIG);
    ({ calls } = installFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the wrapped function's return value", async () => {
    const result = await memora.trace("run-1", async () => 42);
    expect(result).toBe(42);
  });

  it("returns undefined when wrapped function returns undefined", async () => {
    const result = await memora.trace("run-void", async () => undefined);
    expect(result).toBeUndefined();
  });

  it("returns objects correctly", async () => {
    const obj = { decision: "approve", confidence: 0.95 };
    const result = await memora.trace("run-obj", async () => obj);
    expect(result).toStrictEqual(obj);
  });

  it("emits run_started as the first event", async () => {
    await memora.trace("my-run", async () => {});
    expect(calls[0].eventType).toBe("run_started");
    expect(calls[0].missionId).toBe("my-run");
    expect(calls[0].parentIds).toHaveLength(0);
  });

  it("emits run_completed as the last event on success", async () => {
    await memora.trace("my-run", async () => {});
    const last = calls[calls.length - 1];
    expect(last.eventType).toBe("run_completed");
  });

  it("emits run_failed and rethrows on error — does NOT emit run_completed", async () => {
    const error = new Error("business logic failure");

    await expect(
      memora.trace("failing-run", async () => {
        throw error;
      })
    ).rejects.toThrow("business logic failure");

    const types = calls.map((c) => c.eventType);
    expect(types).toContain("run_failed");
    expect(types).not.toContain("run_completed");
  });

  it("run_failed carries the error message", async () => {
    await expect(
      memora.trace("err-run", async () => {
        throw new Error("specific message");
      })
    ).rejects.toThrow();

    const failedEvent = calls.find((c) => c.eventType === "run_failed");
    expect(failedEvent?.content?.error).toBe("specific message");
  });

  it("chains parent_ids sequentially across events", async () => {
    await memora.trace("chain-run", async (trace) => {
      await trace.event("step_one", {});
      await trace.event("step_two", {});
    });

    // Expected: run_started → step_one → step_two → run_completed
    const [runStart, stepOne, stepTwo, runComplete] = calls;

    expect(runStart.eventType).toBe("run_started");
    expect(runStart.parentIds).toHaveLength(0);

    expect(stepOne.eventType).toBe("step_one");
    expect(stepOne.parentIds).toEqual([runStart.returnedId]);

    expect(stepTwo.eventType).toBe("step_two");
    expect(stepTwo.parentIds).toEqual([stepOne.returnedId]);

    expect(runComplete.eventType).toBe("run_completed");
    expect(runComplete.parentIds).toEqual([stepTwo.returnedId]);
  });

  it("trace.event records correct mission_id and event type", async () => {
    await memora.trace("custom-run", async (trace) => {
      await trace.event("my_event", { key: "value" });
    });

    const myEvent = calls.find((c) => c.eventType === "my_event");
    expect(myEvent).toBeDefined();
    expect(myEvent!.missionId).toBe("custom-run");
    expect(myEvent!.content).toMatchObject({ key: "value" });
  });

  it("trace.event returns an EventReceipt with event_id and payload_hash", async () => {
    let receipt: Record<string, unknown> | undefined;
    await memora.trace("receipt-run", async (trace) => {
      receipt = (await trace.event("my_event", {})) as unknown as Record<string, unknown>;
    });
    expect(receipt?.event_id).toBeDefined();
    expect(receipt?.payload_hash).toBeDefined();
  });
});

// ─── wrap() ──────────────────────────────────────────────────────────────────

describe("Memora.wrap()", () => {
  let memora: Memora;
  let calls: CapturedCall[];

  beforeEach(() => {
    _counter = 0;
    memora = new Memora(BASE_CONFIG);
    ({ calls } = installFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the original function's return value", async () => {
    const double = async (x: number) => x * 2;
    const wrapped = memora.wrap("double", double);
    expect(await wrapped(21)).toBe(42);
  });

  it("returns objects correctly", async () => {
    const fn = async (x: string) => ({ processed: x.toUpperCase() });
    const wrapped = memora.wrap("upper", fn);
    expect(await wrapped("hello")).toStrictEqual({ processed: "HELLO" });
  });

  it("records workflow_started event", async () => {
    const wrapped = memora.wrap("my-workflow", async () => "done");
    await wrapped();
    const types = calls.map((c) => c.eventType);
    expect(types).toContain("workflow_started");
  });

  it("records workflow_completed event on success", async () => {
    const wrapped = memora.wrap("my-workflow", async () => "done");
    await wrapped();
    const types = calls.map((c) => c.eventType);
    expect(types).toContain("workflow_completed");
    expect(types).not.toContain("workflow_failed");
  });

  it("records workflow_failed and rethrows — does NOT record workflow_completed", async () => {
    const wrapped = memora.wrap("fail-workflow", async () => {
      throw new Error("workflow error");
    });

    await expect(wrapped()).rejects.toThrow("workflow error");

    const types = calls.map((c) => c.eventType);
    expect(types).toContain("workflow_failed");
    expect(types).not.toContain("workflow_completed");
  });

  it("workflow_failed carries error message", async () => {
    const wrapped = memora.wrap("err-wf", async () => { throw new Error("boom"); });
    await expect(wrapped()).rejects.toThrow();

    const failEvent = calls.find((c) => c.eventType === "workflow_failed");
    expect(failEvent?.content?.error).toBe("boom");
  });

  it("preserves async resolution timing", async () => {
    let settled = false;
    const fn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      settled = true;
      return 1;
    };
    const wrapped = memora.wrap("async-test", fn);
    await wrapped();
    expect(settled).toBe(true);
  });

  it("workflow_started includes workflow name and arg_count", async () => {
    const wrapped = memora.wrap("named-wf", async (_a: number, _b: string) => {});
    await wrapped(1, "x");

    const startEvent = calls.find((c) => c.eventType === "workflow_started");
    expect(startEvent?.content?.workflow).toBe("named-wf");
    expect(startEvent?.content?.arg_count).toBe(2);
  });

  it("each wrap() call creates a distinct run_id (mission_id)", async () => {
    const wrapped = memora.wrap("idempotent", async () => {});
    await wrapped();
    await wrapped();

    const runIds = calls
      .filter((c) => c.eventType === "run_started")
      .map((c) => c.missionId);
    expect(runIds[0]).not.toBe(runIds[1]);
  });
});

// ─── tool() ──────────────────────────────────────────────────────────────────

describe("Memora.tool()", () => {
  let memora: Memora;
  let calls: CapturedCall[];

  beforeEach(() => {
    _counter = 0;
    memora = new Memora(BASE_CONFIG);
    ({ calls } = installFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the tool function's output", async () => {
    const add = memora.tool("add", async (x: number) => x + 1);
    expect(await add(41)).toBe(42);
  });

  it("records tool_called event", async () => {
    const tool = memora.tool("my-tool", async () => "ok");
    await tool({});
    const types = calls.map((c) => c.eventType);
    expect(types).toContain("tool_called");
  });

  it("records tool_result event on success", async () => {
    const tool = memora.tool("my-tool", async () => "ok");
    await tool({});
    const types = calls.map((c) => c.eventType);
    expect(types).toContain("tool_result");
    expect(types).not.toContain("tool_failed");
  });

  it("records tool_failed and rethrows — does NOT record tool_result", async () => {
    const tool = memora.tool("fail-tool", async () => {
      throw new Error("tool error");
    });
    await expect(tool({})).rejects.toThrow("tool error");

    const types = calls.map((c) => c.eventType);
    expect(types).toContain("tool_failed");
    expect(types).not.toContain("tool_result");
  });

  it("tool_called includes input_hash", async () => {
    const tool = memora.tool("hash-tool", async () => "ok");
    await tool({ value: 42 });

    const calledEvent = calls.find((c) => c.eventType === "tool_called");
    expect(typeof calledEvent?.content?.input_hash).toBe("string");
    expect(calledEvent?.content?.input_hash).not.toBe("");
  });

  it("tool_result includes output_hash", async () => {
    const tool = memora.tool("hash-tool", async () => ({ result: 42 }));
    await tool({});

    const resultEvent = calls.find((c) => c.eventType === "tool_result");
    expect(typeof resultEvent?.content?.output_hash).toBe("string");
    expect(resultEvent?.content?.output_hash).not.toBe("");
  });

  it("tool_result includes duration_ms as a number", async () => {
    const tool = memora.tool("timed", async () => "fast");
    await tool({});

    const resultEvent = calls.find((c) => c.eventType === "tool_result");
    expect(typeof resultEvent?.content?.duration_ms).toBe("number");
    expect(resultEvent!.content!.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("tool_called includes tool name", async () => {
    const tool = memora.tool("named-tool", async () => "ok");
    await tool({});

    const calledEvent = calls.find((c) => c.eventType === "tool_called");
    expect(calledEvent?.content?.tool).toBe("named-tool");
  });

  it("different inputs produce different input hashes", async () => {
    const hashes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          payload?: { event_type?: string; content?: Record<string, unknown> };
        };
        if (body.payload?.event_type === "tool_called") {
          hashes.push(body.payload.content?.input_hash as string);
        }
        return { ok: true, json: async () => makeWriteResponse() } as Response;
      })
    );

    const tool = memora.tool("hash-check", async (x: number) => x);
    await tool(1);
    await tool(2);

    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("parent_ids chain within a tool call: tool_called → tool_result", async () => {
    await memora.tool("chain-tool", async () => "ok")({});

    // run_started → tool_called → tool_result → run_completed
    const [runStart, toolCalled, toolResult] = calls;
    expect(runStart.eventType).toBe("run_started");
    expect(toolCalled.eventType).toBe("tool_called");
    expect(toolCalled.parentIds).toEqual([runStart.returnedId]);
    expect(toolResult.eventType).toBe("tool_result");
    expect(toolResult.parentIds).toEqual([toolCalled.returnedId]);
  });
});

// ─── receipt() ───────────────────────────────────────────────────────────────

describe("Memora.receipt()", () => {
  let memora: Memora;
  let calls: CapturedCall[];

  beforeEach(() => {
    _counter = 0;
    memora = new Memora(BASE_CONFIG);
    ({ calls } = installFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records an ai_receipt event", async () => {
    await memora.receipt(async () => ({ ok: true }));
    expect(calls).toHaveLength(1);
    expect(calls[0].eventType).toBe("ai_receipt");
    expect(calls[0].content).toMatchObject({
      receipt_version: "1",
      kind: "ai_execution_receipt",
    });
  });

  it("returns the original result unchanged", async () => {
    const obj = { id: "resp_123", text: "hello" };
    const { result } = await memora.receipt(async () => obj);
    expect(result).toStrictEqual(obj);
  });

  it("computes input_hash when opts.input is provided", async () => {
    const { receipt } = await memora.receipt(
      async () => "out",
      { input: { prompt: "Explain execution receipts" } },
    );
    expect(typeof calls[0].content.input_hash).toBe("string");
    expect(calls[0].content.input_hash).not.toBe("");
    expect(receipt.input_hash).toBe(calls[0].content.input_hash);
  });

  it("computes output_hash from the resolved result", async () => {
    const { receipt } = await memora.receipt(async () => ({ answer: 42 }));
    expect(typeof calls[0].content.output_hash).toBe("string");
    expect(calls[0].content.output_hash).not.toBe("");
    expect(receipt.output_hash).toBe(calls[0].content.output_hash);
  });

  it("includes provider and model in meta", async () => {
    await memora.receipt(async () => "ok", {
      provider: "openai",
      model: "gpt-4.1",
      input: { input: "test" },
    });
    expect(calls[0].meta.provider).toBe("openai");
    expect(calls[0].meta.model).toBe("gpt-4.1");
  });

  it("returns execution_id from the write response", async () => {
    const { receipt } = await memora.receipt(async () => 1);
    expect(receipt.execution_id).toBe(calls[0].returnedId);
    expect(receipt.execution_id).toMatch(/^mem_/);
  });

  it("exposes event_digest when the write response includes event_id", async () => {
    const digest = "b".repeat(64);
    vi.unstubAllGlobals();
    ({ calls } = installFetchMock({ eventId: digest }));

    const { receipt } = await memora.receipt(async () => "ok");
    expect(receipt.event_digest).toBe(digest);
  });

  it("named variant sets name in content and mission_id", async () => {
    await memora.receipt("ai.call", async () => "ok", {
      provider: "anthropic",
      model: "claude-opus-4-20250514",
    });
    expect(calls[0].content.name).toBe("ai.call");
    expect(calls[0].missionId).toBe("ai.call");
  });

  it("rethrows on error without recording a receipt", async () => {
    await expect(
      memora.receipt(async () => {
        throw new Error("api failure");
      }),
    ).rejects.toThrow("api failure");
    expect(calls).toHaveLength(0);
  });

  it("sets verification_status to recorded", async () => {
    const { receipt } = await memora.receipt(async () => "ok");
    expect(receipt.verification_status).toBe("recorded");
  });

  it("omits input_hash when opts.input is not provided", async () => {
    const { receipt } = await memora.receipt(async () => "ok");
    expect(calls[0].content.input_hash).toBeUndefined();
    expect(receipt.input_hash).toBeUndefined();
  });
});

// ─── Deployment modes ────────────────────────────────────────────────────────

describe("Memora deployment modes", () => {
  it("warns once when deprecated mode/backend are set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Memora({
      agentId: "agent",
      endpoint: "http://localhost:3001",
      mode: "full_on_chain",
      backend: "hedera",
    });
    new Memora({
      agentId: "agent-2",
      endpoint: "http://localhost:3001",
      mode: "enterprise",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/deprecated/i);
    warn.mockRestore();
  });

  it("enterprise mode initialises without keyBrokerEndpoint", () => {
    expect(() =>
      new Memora({
        agentId: "agent",
        endpoint: "http://localhost:3001",
        mode: "enterprise",
        backend: "local",
      })
    ).not.toThrow();
  });

  it("enterprise mode initialises without apiKey", () => {
    expect(() =>
      new Memora({
        agentId: "agent",
        endpoint: "http://localhost:3001",
        mode: "enterprise",
      })
    ).not.toThrow();
  });

  it("anchored mode initialises fine", () => {
    expect(() =>
      new Memora({
        agentId: "agent",
        endpoint: "http://localhost:3001",
        mode: "anchored",
        backend: "hybrid",
      })
    ).not.toThrow();
  });

  it("full_on_chain mode initialises with standard config", () => {
    expect(() =>
      new Memora({
        agentId: "agent",
        endpoint: "http://localhost:3001",
        apiKey: "key",
        keyBrokerEndpoint: "http://localhost:3000",
        mode: "full_on_chain",
        backend: "hedera",
      })
    ).not.toThrow();
  });

  it("throws if agentId is missing", () => {
    expect(() =>
      new Memora({ agentId: "", endpoint: "http://localhost:3001" })
    ).toThrow(/agentId/);
  });

  it("throws if agentId is whitespace-only", () => {
    expect(() =>
      new Memora({ agentId: "   ", endpoint: "http://localhost:3001" })
    ).toThrow(/agentId/);
  });

  it("defaults to hosted gateway when baseUrl and endpoint are omitted", () => {
    expect(() =>
      new Memora({ agentId: "agent", apiKey: "key" })
    ).not.toThrow();
  });

  it("defaults to hosted gateway when endpoint is empty", () => {
    expect(() =>
      new Memora({ agentId: "agent", endpoint: "" })
    ).not.toThrow();
  });

  it("initialises with baseUrl (gateway mode)", () => {
    expect(() =>
      new Memora({ agentId: "agent", baseUrl: "http://localhost:8787", apiKey: "key" })
    ).not.toThrow();
  });

  it("baseUrl takes precedence when both baseUrl and endpoint are provided", () => {
    expect(() =>
      new Memora({ agentId: "agent", baseUrl: "http://gw:8787", endpoint: "http://idx:3001" })
    ).not.toThrow();
  });

  it("exposes underlying client via .client getter", () => {
    const m = new Memora({ agentId: "agent", endpoint: "http://localhost:3001" });
    expect(m.client).toBeDefined();
    expect(typeof m.client.write).toBe("function");
  });
});

// ─── baseUrl (gateway) mode ──────────────────────────────────────────────────

describe("Memora baseUrl (gateway) mode", () => {
  let calls: CapturedCall[];

  beforeEach(() => {
    _counter = 0;
    ({ calls } = installFetchMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("write calls /v1/events when baseUrl is set", async () => {
    const memora = new Memora({ agentId: "agent", apiKey: "key", baseUrl: "http://gateway:8787" });
    await memora.trace("run-1", async () => {});
    expect(calls[0].url).toContain("/v1/events");
    expect(calls[0].url).not.toContain("/write");
  });

  it("write still calls /write when only endpoint is set (direct mode)", async () => {
    const memora = new Memora({ agentId: "agent", apiKey: "key", endpoint: "http://indexer:3001" });
    await memora.trace("run-1", async () => {});
    expect(calls[0].url).toContain("/write");
    expect(calls[0].url).not.toContain("/v1/");
  });

  it("baseUrl mode: gateway URL is used for all write calls", async () => {
    const memora = new Memora({ agentId: "agent", baseUrl: "http://gw:8787" });
    await memora.trace("run-1", async (trace) => { await trace.event("step", {}); });
    for (const call of calls) {
      expect(call.url).toContain("http://gw:8787");
      expect(call.url).toContain("/v1/events");
    }
  });

  it("hosted default: calls api.getmemora.dev when baseUrl omitted", async () => {
    const memora = new Memora({ agentId: "agent", apiKey: "key" });
    await memora.trace("run-1", async (trace) => { await trace.event("step", {}); });
    for (const call of calls) {
      expect(call.url).toContain(MEMORA_HOSTED_BASE_URL);
      expect(call.url).toContain("/v1/events");
    }
  });
});
