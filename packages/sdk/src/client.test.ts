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
