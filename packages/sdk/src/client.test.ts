/**
 * Tests for MemoraClient v1Routes path resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoraClient } from "./client.js";

function makeWriteResponse(id = "mem_001") {
  return {
    memory_id: id,
    cid_ciphertext: "QmMock",
    payload_hash: "deadbeef",
    hcs_topic_id: "0.0.99999",
    contract_tx_hash: "0xdeadbeef",
  };
}

function installFetchMock(): { calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return {
      ok: true,
      json: async () => makeWriteResponse(),
      text: async () => "[]",
    } as Response;
  }));
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const WRITE_OPTS = {
  agentId: "agent-1",
  contentType: "application/json",
  content: { test: true },
};

describe("MemoraClient — v1Routes: false (default / direct mode)", () => {
  let client: MemoraClient;
  let calls: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    client = new MemoraClient({
      indexerBaseUrl:   "http://indexer:3001",
      keyBrokerBaseUrl: "http://broker:3000",
      v1Routes: false,
    });
    ({ calls } = installFetchMock());
  });

  it("write() calls /write", async () => {
    await client.write(WRITE_OPTS);
    expect(calls[0][0]).toBe("http://indexer:3001/write");
  });

  it("query() calls /memories", async () => {
    await client.query({ agentId: "agent-1" });
    expect(calls[0][0]).toContain("/memories");
    expect(calls[0][0]).not.toContain("/v1/");
  });

  it("flush() calls /batch/flush", async () => {
    await client.flush();
    expect(calls[0][0]).toContain("/batch/flush");
    expect(calls[0][0]).not.toContain("/v1/");
  });
});

describe("MemoraClient — v1Routes: true (gateway mode)", () => {
  let client: MemoraClient;
  let calls: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    client = new MemoraClient({
      indexerBaseUrl:   "http://gateway:8787",
      keyBrokerBaseUrl: "http://gateway:8787",
      v1Routes: true,
    });
    ({ calls } = installFetchMock());
  });

  it("write() calls /v1/events", async () => {
    await client.write(WRITE_OPTS);
    expect(calls[0][0]).toBe("http://gateway:8787/v1/events");
  });

  it("query() calls /v1/events", async () => {
    await client.query({ agentId: "agent-1" });
    expect(calls[0][0]).toContain("/v1/events");
  });

  it("flush() calls /v1/batches/flush", async () => {
    await client.flush();
    expect(calls[0][0]).toContain("/v1/batches/flush");
  });
});

describe("MemoraClient — path isolation between modes", () => {
  it("v1Routes:false and v1Routes:true produce different paths for write", async () => {
    const { calls: calls1 } = installFetchMock();
    const direct = new MemoraClient({ indexerBaseUrl: "http://x:3001", keyBrokerBaseUrl: "http://x:3001", v1Routes: false });
    await direct.write(WRITE_OPTS);
    const path1 = calls1[0][0];

    vi.unstubAllGlobals();
    const { calls: calls2 } = installFetchMock();
    const gateway = new MemoraClient({ indexerBaseUrl: "http://x:8787", keyBrokerBaseUrl: "http://x:8787", v1Routes: true });
    await gateway.write(WRITE_OPTS);
    const path2 = calls2[0][0];

    expect(path1).toContain("/write");
    expect(path1).not.toContain("/v1/");
    expect(path2).toContain("/v1/events");
    expect(path2).not.toContain("/write");
  });
});

describe.each([false, true])("protected API reads (gateway=%s)", (v1Routes) => {
  const base = "https://api.memora.test/prefix";
  const config = (writeSecret?: string) => ({ indexerBaseUrl: base + "/", keyBrokerBaseUrl: "https://broker.test", v1Routes, writeSecret });

  it.each([undefined, "", "synthetic-api-key"])("uses only the configured credential: %s", async (secret) => {
    const { calls } = installFetchMock();
    const client = new MemoraClient(config(secret));
    await client.query({ agentId: "a?agent_id=foreign", taskId: "task/#", limit: 5, offset: 2 });
    await client.verify("id/?#https://foreign.test");
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(new URL(url).origin).toBe("https://api.memora.test");
      expect(new Headers(init?.headers).get("Authorization")).toBe(secret ? `Bearer ${secret}` : null);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("x-memora-workspace-id")).toBe(false);
    }
    const query = new URL(calls[0][0]);
    expect(query.pathname).toBe(v1Routes ? "/prefix/v1/events" : "/prefix/memories");
    expect(query.searchParams.get("agent_id")).toBe("a?agent_id=foreign");
    expect(query.searchParams.get("task_id")).toBe("task/#");
    expect(calls[1][0]).toContain("id%2F%3F%23https%3A%2F%2Fforeign.test");
  });

  it("pins the read API destination at construction", async () => {
    const { calls } = installFetchMock();
    const options = config("synthetic-api-key");
    const client = new MemoraClient(options);
    options.indexerBaseUrl = "https://foreign.test";
    await client.query({ agentId: "agent-1" });
    expect(new URL(calls[0][0]).origin).toBe("https://api.memora.test");
  });

  it.each([".", ".."])('rejects route traversal ID "%s" before sending credentials', async (id) => {
    const { calls } = installFetchMock();
    const result = await new MemoraClient(config("synthetic-api-key")).verify(id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Invalid Memora API read URL/);
    expect(calls).toHaveLength(0);
  });

  it.each(["ftp://api.test", "https://api.test?route=", "https://api.test#fragment", "https://user:password@api.test"])("rejects an ambiguous read API base %s", async (indexerBaseUrl) => {
    const { calls } = installFetchMock();
    const client = new MemoraClient({ ...config("synthetic-api-key"), indexerBaseUrl });
    await expect(client.query({ agentId: "agent-1" })).rejects.toThrow(/Invalid Memora API read URL/);
    expect(calls).toHaveLength(0);
  });

  it("keeps the existing verify result when the authorized reference lacks chain proof", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ payload_hash: "ab".repeat(32) }) }));
    const client = new MemoraClient(config("synthetic-api-key"));
    expect(await client.verify("memory-id")).toEqual({ valid: false, reason: "no contract_tx_hash" });
    expect(await client.verify("memory-id", "cd".repeat(32))).toEqual({ valid: false, reason: "payload_hash mismatch" });
  });

  it.each([
    ["supabase", "https://foreign.test/payload"],
    ["supabase", "https://api.memora.test/prefix/v1/events"],
    ["ipfs", "https://ipfs.test/ipfs/"],
  ])("does not attach API credentials to %s ciphertext at %s", async (storage_provider, location) => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, json: async () => calls.length === 1
        ? { storage_provider, storage_uri: location, cid_ciphertext: "QmSynthetic", payload_hash: "ab".repeat(32) }
        : {} };
    }));
    const client = new MemoraClient({ ...config("synthetic-api-key"), ipfsGatewayUrl: location });
    await expect(client.read("memory-id", async () => "signature", "wallet")).rejects.toThrow(/Malformed ciphertext bundle/);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-api-key");
    expect(new Headers(calls[1][1]?.headers).has("Authorization")).toBe(false);
    expect(calls[1][0]).toBe(storage_provider === "supabase" ? location : location + "QmSynthetic");
  });
});
