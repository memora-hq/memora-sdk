/**
 * Unit tests for optional agent precommit signing on MemoraClient.write().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalizePayload,
  DEFAULT_MEMORA_VERSION,
} from "@memora-hq/memora-protocol/dist/canonicalize.js";
import { hashPayload } from "@memora-hq/memora-protocol/dist/crypto.js";
import {
  verifyAgentSignature,
} from "@memora-hq/memora-protocol/dist/envelope.js";
import { MemoraClient } from "./client.js";
import {
  createPrivateKeyAgentSigner,
  buildAgentPrecommitFields,
  absentTaskSentinel,
  type AgentEventSigner,
} from "./agentSigner.js";
import { Memora } from "./tracer.js";

const AGENT_KEY = "0x" + "11".repeat(32);
const WRONG_KEY = "0x" + "22".repeat(32);
const PARENT = "mem_parent_001";

function parseBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("createPrivateKeyAgentSigner", () => {
  it("derives a stable address and never exposes the private key on the object", () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(signer)).not.toContain(AGENT_KEY.slice(2));
    expect(Object.keys(signer)).not.toContain("privateKey");
  });

  it("rejects empty private keys", () => {
    expect(() => createPrivateKeyAgentSigner("")).toThrow(/privateKey/);
  });
});

describe("MemoraClient.write — agent precommit signing", () => {
  let calls: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          memory_id: "mem_signed",
          cid_ciphertext: "QmMock",
          payload_hash: "deadbeef",
          hcs_topic_id: "0.0.1",
          contract_tx_hash: "0xabc",
        }),
      } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves writes unsigned when no signer is configured (standard mode)", async () => {
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      writeSecret: "api-key",
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { n: 1 },
    });
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBeUndefined();
    expect(body.agent_signature).toBeUndefined();
    expect(calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer api-key" });
  });

  it("attaches a valid signature over raw agent id, payload commitment, task, and parents", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      writeSecret: "api-key",
      agentSigner: signer,
    });
    await client.write({
      agentId: "agent-raw-id",
      contentType: "application/json",
      content: { hello: "world" },
      taskId: "task-42",
      lineage: {
        event_type: "tool_called",
        parent_ids: [PARENT],
      },
    });
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBe(signer.address);
    expect(typeof body.agent_signature).toBe("string");
    expect(JSON.stringify(body)).not.toContain(AGENT_KEY.slice(2));

    const payload = body.payload as Record<string, unknown>;
    const payloadHash = hashPayload(canonicalizePayload(payload as never));
    const fields = buildAgentPrecommitFields({
      agentId: "agent-raw-id",
      signerAddress: signer.address,
      parentIds: [PARENT],
      payloadHash,
      taskId: "task-42",
    });
    expect(verifyAgentSignature(fields, body.agent_signature as string, signer.address).valid).toBe(true);
  });

  it("uses the zero-task sentinel when taskId is absent", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://gateway:8787",
      keyBrokerBaseUrl: "http://gateway:8787",
      writeSecret: "api-key",
      agentSigner: signer,
      v1Routes: true,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { x: 1 },
      lineage: { event_type: "run_started", parent_ids: [] },
    });
    const body = parseBody(calls[0][1]);
    const payload = body.payload as Record<string, unknown>;
    const payloadHash = hashPayload(canonicalizePayload(payload as never));
    const fields = buildAgentPrecommitFields({
      agentId: "agent-a",
      signerAddress: signer.address,
      parentIds: [],
      payloadHash,
    });
    expect(fields.task_id).toBe(absentTaskSentinel());
    expect(verifyAgentSignature(fields, body.agent_signature as string, signer.address).valid).toBe(true);
    expect(calls[0][0]).toBe("http://gateway:8787/v1/events");
  });

  it("does not silently drop the signature when a signer is configured", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      agentSigner: signer,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { keep: true },
    });
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBe(signer.address);
    expect(body.agent_signature).toBeTruthy();
  });

  it("rejects a forged signature over a mutated payload commitment", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      agentSigner: signer,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { original: true },
      taskId: "t1",
      lineage: { parent_ids: [PARENT], event_type: "decision_made" },
    });
    const body = parseBody(calls[0][1]);
    const mutatedHash = hashPayload(canonicalizePayload({
      memora_version: DEFAULT_MEMORA_VERSION,
      contentType: "application/json",
      content: { original: false },
      event_type: "decision_made",
      parent_ids: [PARENT],
      taskId: "t1",
    } as never));
    const fields = buildAgentPrecommitFields({
      agentId: "agent-a",
      signerAddress: signer.address,
      parentIds: [PARENT],
      payloadHash: mutatedHash,
      taskId: "t1",
    });
    expect(verifyAgentSignature(fields, body.agent_signature as string, signer.address).valid).toBe(false);
  });

  it("rejects verification when parents or task differ from what was signed", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      agentSigner: signer,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { n: 1 },
      taskId: "task-a",
      lineage: { parent_ids: [PARENT], event_type: "tool_called" },
    });
    const body = parseBody(calls[0][1]);
    const payloadHash = hashPayload(canonicalizePayload(body.payload as never));
    expect(verifyAgentSignature(
      buildAgentPrecommitFields({
        agentId: "agent-a",
        signerAddress: signer.address,
        parentIds: ["other-parent"],
        payloadHash,
        taskId: "task-a",
      }),
      body.agent_signature as string,
      signer.address,
    ).valid).toBe(false);
    expect(verifyAgentSignature(
      buildAgentPrecommitFields({
        agentId: "agent-a",
        signerAddress: signer.address,
        parentIds: [PARENT],
        payloadHash,
        taskId: "task-b",
      }),
      body.agent_signature as string,
      signer.address,
    ).valid).toBe(false);
  });

  it("allows a per-write signer override", async () => {
    const configSigner = createPrivateKeyAgentSigner(AGENT_KEY);
    const override = createPrivateKeyAgentSigner(WRONG_KEY);
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      agentSigner: configSigner,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { n: 1 },
      agentSigner: override,
    });
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBe(override.address);
  });

  it("propagates malformed signature callbacks without stripping agent_signer", async () => {
    const good = createPrivateKeyAgentSigner(AGENT_KEY);
    const bad: AgentEventSigner = {
      address: good.address,
      async signDigest() {
        return "0xdead";
      },
    };
    const client = new MemoraClient({
      indexerBaseUrl: "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      agentSigner: bad,
    });
    await client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { n: 1 },
    });
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBe(good.address);
    expect(body.agent_signature).toBe("0xdead");
  });
});

describe("Memora high-level config wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes agentSigner through Memora({ apiKey, agentSigner }) gateway mode", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          memory_id: "mem_hi",
          cid_ciphertext: "Qm",
          payload_hash: "aa",
          hcs_topic_id: "0.0.1",
          contract_tx_hash: "0x1",
        }),
      } as Response;
    }));

    const memora = new Memora({
      agentId: "agent-a",
      apiKey: "sk_test",
      baseUrl: "http://gateway:8787",
      agentSigner: signer,
    });
    await memora.recordEvent("run_1", "input_received", { ok: true });
    expect(calls[0][0]).toBe("http://gateway:8787/v1/events");
    const body = parseBody(calls[0][1]);
    expect(body.agent_signer).toBe(signer.address);
    expect(calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer sk_test" });
  });

  it("passes agentSigner through direct-indexer Memora({ endpoint }) mode", async () => {
    const signer = createPrivateKeyAgentSigner(AGENT_KEY);
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          memory_id: "mem_direct",
          cid_ciphertext: "Qm",
          payload_hash: "aa",
          hcs_topic_id: "0.0.1",
          contract_tx_hash: "0x1",
        }),
      } as Response;
    }));

    const memora = new Memora({
      agentId: "agent-a",
      apiKey: "sk_test",
      endpoint: "http://indexer:3001",
      keyBrokerEndpoint: "http://broker:3000",
      agentSigner: signer,
    });
    await memora.client.write({
      agentId: "agent-a",
      contentType: "application/json",
      content: { direct: true },
    });
    expect(calls[0][0]).toBe("http://indexer:3001/write");
    expect(parseBody(calls[0][1]).agent_signer).toBe(signer.address);
  });
});
