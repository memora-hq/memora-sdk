/**
 * MemoraClient: cloud mode (calls indexer + key-broker + IPFS gateway).
 */

import { hashPayload, decrypt } from "@memora-hq/memora-protocol/dist/crypto.js";
import {
  canonicalizePayload,
  DEFAULT_MEMORA_VERSION,
} from "@memora-hq/memora-protocol/dist/canonicalize.js";
import type {
  MemoryPayload,
  MemoryRef,
  EncryptedPayloadBundle,
  AccessPolicySummary,
} from "@memora-hq/memora-protocol/dist/types.js";
import {
  buildAgentPrecommitFields,
  signAgentPrecommit,
  type AgentEventSigner,
} from "./agentSigner.js";

export interface MemoraClientConfig {
  indexerBaseUrl: string;
  keyBrokerBaseUrl: string;
  /** IPFS gateway for fetching ciphertext by CID (e.g. https://gateway.pinata.cloud/ipfs/) */
  ipfsGatewayUrl?: string;
  /** Memora API Bearer credential for writes and protected reads (operator secret or per-agent API key). */
  writeSecret?: string;
  /**
   * When true, use /v1/ gateway API paths instead of direct indexer/key-broker paths.
   * Set automatically when constructing Memora with `baseUrl`.
   * Default: false (backward-compatible direct paths).
   */
  v1Routes?: boolean;
  /**
   * Optional agent precommit signer for verified-mode writes.
   * Private keys stay client-side; only address + signature are transmitted.
   * Bearer API auth remains separate and required.
   */
  agentSigner?: AgentEventSigner;
}

/** Lineage metadata for execution graph (v0.2). All optional. */
export interface WriteLineageOptions {
  event_type?: string;
  mission_id?: string;
  parent_ids?: string[];
  derived_from?: string[];
  tool_ref?: string;
  capsule_id?: string;
  actor_type?: "agent" | "user" | "system";
  actor_id?: string;
}

export interface WriteOptions {
  agentId: string;
  contentType: string;
  content: unknown;
  tags?: string[];
  taskId?: string;
  access?: AccessPolicySummary;
  /** Optional metadata; included in canonical bytes for hashing. */
  meta?: Record<string, unknown>;
  /** v0.2 execution lineage (optional). Defaults memora_version to "0.2" when provided. */
  lineage?: WriteLineageOptions;
  /**
   * Per-write agent precommit signer. Overrides MemoraClientConfig.agentSigner.
   * When set, the write always attaches agent_signer + agent_signature (no silent downgrade).
   */
  agentSigner?: AgentEventSigner;
  /**
   * Optional producer idempotency key (Slice 14). Retries with the same key and
   * content return the same accepted evidence identity. Does **not** imply the
   * agent's external business action should re-execute — only that transport
   * retries seek the same receipt.
   */
  idempotencyKey?: string;
}

export interface WriteReceipt {
  memory_id: string;
  /** Deterministic event digest (sha256 of commit base). Returned by indexer when available. */
  event_id?: string;
  cid_ciphertext: string;
  payload_hash: string;
  hcs_topic_id: string;
  contract_tx_hash: string;
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export interface FlushResult {
  ok: boolean;
  batches_created: number;
  events_batched:  number;
}

function validateMemoryId(memoryId: string): void {
  if (!memoryId || typeof memoryId !== "string") {
    throw new Error("Invalid memory_id: must be a non-empty string");
  }
  const trimmed = memoryId.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid memory_id: must be a non-empty string");
  }
}

export class MemoraClient {
  private readonly readApiBaseUrl: string;

  constructor(private config: MemoraClientConfig) {
    if (!this.config.indexerBaseUrl?.trim()) {
      throw new Error("MemoraClientConfig.indexerBaseUrl is required");
    }
    if (!this.config.keyBrokerBaseUrl?.trim()) {
      throw new Error("MemoraClientConfig.keyBrokerBaseUrl is required");
    }
    // Pin the read destination independently of later caller mutation of config.
    this.readApiBaseUrl = this.config.indexerBaseUrl.trim().replace(/\/+$/, "");
  }

  private paths() {
    if (this.config.v1Routes) {
      return {
        write:      "/v1/events",
        batchFlush: "/v1/batches/flush",
        memory:     (id: string) => `/v1/events/${encodeURIComponent(id)}`,
        memories:   "/v1/events",
        evidence:   (id: string) => `/v1/events/${encodeURIComponent(id)}/evidence`,
        export:     (id: string) => `/v1/events/${encodeURIComponent(id)}/export`,
        challenge:  "/v1/keys/challenge",
        keyRelease: "/v1/keys/release",
        workspaceKeyRelease: "/v1/keys/workspace",
      };
    }
    return {
      write:      "/write",
      batchFlush: "/batch/flush",
      memory:     (id: string) => `/memory/${encodeURIComponent(id)}`,
      memories:   "/memories",
      evidence:   (id: string) => `/memory/${encodeURIComponent(id)}/evidence`,
      export:     (id: string) => `/memory/${encodeURIComponent(id)}/export`,
      challenge:  "/challenge",
      keyRelease: "/keys",
      workspaceKeyRelease: "/keys/workspace",
    };
  }

  /** Write memory via indexer POST /write (cloud mode). */
  async write(options: WriteOptions): Promise<WriteReceipt> {
    if (!options?.agentId?.trim()) {
      throw new Error("WriteOptions.agentId is required");
    }
    if (!options?.contentType?.trim()) {
      throw new Error("WriteOptions.contentType is required");
    }
    const lineage = options.lineage;
    const parentIds = Array.isArray(lineage?.parent_ids) ? [...lineage.parent_ids] : [];
    const payload: MemoryPayload = {
      memora_version: lineage ? DEFAULT_MEMORA_VERSION : undefined,
      contentType: options.contentType,
      content: options.content,
      tags: options.tags,
      taskId: options.taskId,
      access: options.access,
      ...(options.meta != null && { meta: options.meta }),
      ...(lineage && {
        event_type: lineage.event_type,
        mission_id: lineage.mission_id,
        parent_ids: Array.isArray(lineage.parent_ids) ? lineage.parent_ids : undefined,
        derived_from: Array.isArray(lineage.derived_from) ? lineage.derived_from : undefined,
        tool_ref: lineage.tool_ref,
        capsule_id: lineage.capsule_id,
        actor_type: lineage.actor_type,
        actor_id: lineage.actor_id,
      }),
    };

    const body: Record<string, unknown> = {
      payload,
      agent_id: options.agentId,
      task_id: options.taskId,
    };

    // Optional cryptographic agent signing — separate from Bearer API auth.
    // Never reads private keys from env; never logs keys.
    const signer = options.agentSigner ?? this.config.agentSigner;
    if (signer) {
      if (!signer.address?.trim()) {
        throw new Error("agentSigner.address is required for verified-mode writes");
      }
      const payloadHash = hashPayload(canonicalizePayload(payload));
      const fields = buildAgentPrecommitFields({
        agentId: options.agentId,
        signerAddress: signer.address,
        parentIds,
        payloadHash,
        taskId: options.taskId,
      });
      const agent_signature = await signAgentPrecommit(signer, fields);
      body.agent_signer = signer.address;
      body.agent_signature = agent_signature;
    }

    const writeHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.writeSecret) {
      writeHeaders["Authorization"] = `Bearer ${this.config.writeSecret}`;
    }
    if (options.idempotencyKey?.trim()) {
      writeHeaders["Idempotency-Key"] = options.idempotencyKey.trim();
    }
    const res = await fetch(`${this.config.indexerBaseUrl}${this.paths().write}`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || String(err));
    }
    return res.json() as Promise<WriteReceipt>;
  }

  /** Query memories by agent_id and/or task_id. */
  async query(params: { agentId?: string; taskId?: string; limit?: number; offset?: number }): Promise<MemoryRef[]> {
    const q = new URLSearchParams();
    if (params.agentId) q.set("agent_id", params.agentId);
    if (params.taskId) q.set("task_id", params.taskId);
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    const res = await this.fetchApiRead(`${this.paths().memories}?${q}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /**
   * Read memory: fetch ref from indexer, ciphertext from IPFS, key from key-broker (with challenge/signature),
   * decrypt and verify payload_hash.
   */
  async read(
    memoryId: string,
    signMessage: (message: string) => Promise<string>,
    requesterAddress: string
  ): Promise<MemoryPayload> {
    validateMemoryId(memoryId);
    if (!requesterAddress?.trim()) {
      throw new Error("requesterAddress is required for read");
    }
    const ref = await this.getRef(memoryId);

    // Phase 11: dispatch ciphertext fetch based on storage_provider.
    // Supabase Storage: fetch from public URI (no Supabase client needed).
    // IPFS (or legacy records with storage_provider = null): use IPFS gateway.
    let ctRes: Response;
    if (ref.storage_provider === "supabase" && ref.storage_uri) {
      ctRes = await fetch(ref.storage_uri);
      if (!ctRes.ok) {
        throw new Error(`Failed to fetch ciphertext from Supabase Storage: ${ctRes.status}`);
      }
    } else {
      let gateway = this.config.ipfsGatewayUrl || "https://gateway.pinata.cloud/ipfs/";
      if (!/^https?:\/\//i.test(gateway)) gateway = "https://" + gateway;
      gateway = gateway.replace(/\/?$/, "/");
      const cid = ref.cid_ciphertext.replace(/^ipfs:\/\//, "");
      ctRes = await fetch(`${gateway}${cid}`);
      if (!ctRes.ok) {
        throw new Error(`Failed to fetch ciphertext from IPFS: ${ctRes.status} (CID: ${cid})`);
      }
    }

    let bundle: EncryptedPayloadBundle;
    try {
      bundle = (await ctRes.json()) as EncryptedPayloadBundle;
    } catch {
      throw new Error("Malformed ciphertext bundle: response is not valid JSON");
    }
    if (!bundle?.alg || !bundle?.nonce || !bundle?.ciphertext || !bundle?.tag) {
      throw new Error("Malformed ciphertext bundle: missing alg, nonce, ciphertext, or tag");
    }

    const challengeRes = await fetch(
      `${this.config.keyBrokerBaseUrl}${this.paths().challenge}?memory_id=${encodeURIComponent(memoryId)}&requester=${encodeURIComponent(requesterAddress)}`
    );
    if (!challengeRes.ok) {
      throw new Error(`Failed to get key broker challenge: ${challengeRes.status}`);
    }
    const challengeData = (await challengeRes.json()) as { nonce: string; message: string };
    // Reconstruct the message to sign from the nonce rather than trusting the
    // server-supplied `message`. A rogue or MITM'd key-broker could otherwise
    // return arbitrary text and get the consumer's wallet to personal_sign it
    // (off-chain signature replay). The challenge format is fixed and public.
    if (!challengeData?.nonce || typeof challengeData.nonce !== "string") {
      throw new Error("Malformed key broker challenge: missing nonce");
    }
    const expectedMessage = `Memora key access: ${challengeData.nonce}`;
    if (challengeData.message !== expectedMessage) {
      throw new Error("Key broker challenge message does not match expected format — refusing to sign");
    }
    const signature = await signMessage(expectedMessage);

    const keyRes = await fetch(`${this.config.keyBrokerBaseUrl}${this.paths().keyRelease}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory_id: memoryId,
        requester: requesterAddress,
        signature,
        challenge: challengeData.nonce,
      }),
    });
    if (!keyRes.ok) {
      const err = await keyRes.json().catch(() => ({})) as { error?: string };
      const msg = err?.error ?? (keyRes.status === 403 ? "Key release denied: not owner or delegate" : "Key release denied");
      throw new Error(`Key broker refused key: ${msg}`);
    }
    const keyData = (await keyRes.json()) as { key: string };
    const key = Buffer.from(keyData.key, "base64");
    const plaintext = decrypt(bundle, key);
    // Verify hash against the exact bytes that were encrypted (canonical string). Do not
    // re-canonicalize after JSON.parse: number/encoding round-trips can change the string.
    const computedHash = hashPayload(plaintext);
    const payload = JSON.parse(plaintext) as MemoryPayload;
    const expectedHash = (ref.payload_hash && typeof ref.payload_hash === "string")
      ? (ref.payload_hash.startsWith("0x") ? ref.payload_hash.slice(2) : ref.payload_hash)
      : String(ref.payload_hash ?? "");
    if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
      const err = new Error("Payload hash mismatch: content may be tampered or corrupted") as Error & { computedHash?: string; expectedHash?: string };
      err.computedHash = computedHash;
      err.expectedHash = expectedHash;
      throw err;
    }
    return payload;
  }

  /**
   * Download an authenticated hosted evidence-export container (Foundation Slice 10/11).
   * Sealed by default — never embeds private keys or API credentials.
   * When `disclose: true`, releases keys under the caller's principal, decrypts each
   * event, and attaches `disclosed_payload` only after plaintext hashes to payload_hash.
   */
  async exportEvidence(
    memoryId: string,
    options?: { includeParents?: boolean; disclose?: boolean },
  ): Promise<Record<string, unknown>> {
    validateMemoryId(memoryId);
    const q = options?.includeParents ? "?parents=1" : "";
    const res = await this.fetchApiRead(`${this.paths().export(memoryId)}${q}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; reason?: string };
      if (res.status === 422 || err.reason === "original_proof_unavailable" || err.error === "original_proof_unavailable") {
        throw new Error("original_proof_unavailable");
      }
      throw new Error(err.error || `Evidence export failed: ${res.status}`);
    }
    const doc = await res.json() as {
      format?: string;
      events?: Array<{
        memory_id: string;
        artifact_bytes_b64: string;
        disclosed_payload?: MemoryPayload | null;
      }>;
      [key: string]: unknown;
    };
    if (!options?.disclose) return doc;

    if (!this.config.writeSecret?.trim()) {
      throw new Error("disclose requires MemoraClientConfig.writeSecret for authorized workspace key release");
    }
    if (!Array.isArray(doc.events)) {
      throw new Error("invalid hosted evidence export: missing events");
    }

    for (const event of doc.events) {
      const artifact = JSON.parse(Buffer.from(event.artifact_bytes_b64, "base64").toString("utf8")) as {
        scope?: { workspace_id?: string | null; raw_agent_id?: string };
        commit_bytes_b64?: string;
      };
      const commit = JSON.parse(Buffer.from(artifact.commit_bytes_b64 ?? "", "base64").toString("utf8")) as {
        memory_id?: string;
        event_id?: string;
        agent_id?: string;
        payload_hash?: string;
        cid_ciphertext?: string;
      };
      const workspaceId = artifact.scope?.workspace_id;
      const agentId = artifact.scope?.raw_agent_id ?? commit.agent_id;
      const eventId = commit.event_id;
      const mid = commit.memory_id ?? event.memory_id;
      if (!workspaceId || !agentId || !eventId || !mid || !commit.payload_hash) {
        throw new Error(`cannot disclose ${event.memory_id}: original scope/commit incomplete`);
      }

      const releaseBody = JSON.stringify({
        release_mode: "workspace",
        memory_id: mid,
        workspace_id: workspaceId,
        agent_id: agentId,
        event_id: eventId,
      });
      const keyRes = await fetch(`${this.config.keyBrokerBaseUrl}${this.paths().workspaceKeyRelease}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.writeSecret}`,
          "Content-Type": "application/json",
        },
        body: releaseBody,
        redirect: "error",
      });
      if (!keyRes.ok) {
        const err = await keyRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || `Workspace key release denied for ${mid}: ${keyRes.status}`);
      }
      const keyData = (await keyRes.json()) as { key?: string };
      if (!keyData.key) throw new Error(`Workspace key release returned no key for ${mid}`);
      // Key material is used ephemerally for decrypt+hash check and never written into the export.
      const key = Buffer.from(keyData.key, "base64");

      const ref = await this.getRef(mid);
      let ctRes: Response;
      if (ref.storage_provider === "supabase" && ref.storage_uri) {
        ctRes = await fetch(ref.storage_uri);
      } else {
        let gateway = this.config.ipfsGatewayUrl || "https://gateway.pinata.cloud/ipfs/";
        if (!/^https?:\/\//i.test(gateway)) gateway = "https://" + gateway;
        gateway = gateway.replace(/\/?$/, "/");
        const cid = (ref.cid_ciphertext || commit.cid_ciphertext || "").replace(/^ipfs:\/\//, "");
        ctRes = await fetch(`${gateway}${cid}`);
      }
      if (!ctRes.ok) throw new Error(`Failed to fetch ciphertext for disclosure of ${mid}: ${ctRes.status}`);
      const bundle = (await ctRes.json()) as EncryptedPayloadBundle;
      if (!bundle?.alg || !bundle?.nonce || !bundle?.ciphertext || !bundle?.tag) {
        throw new Error(`Malformed ciphertext bundle for ${mid}`);
      }
      const plaintext = decrypt(bundle, key);
      const computedHash = hashPayload(plaintext);
      const expectedHash = commit.payload_hash.startsWith("0x")
        ? commit.payload_hash.slice(2)
        : commit.payload_hash;
      if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error(`disclosed plaintext contradicts payload_hash for ${mid}`);
      }
      event.disclosed_payload = JSON.parse(plaintext) as MemoryPayload;
    }

    return doc;
  }

  /**
   * Verify: fetch ref metadata. Index flags / chain hashes are not cryptographic
   * original proof — use exportEvidence + offline verifyHostedEvidenceExport for that.
   */
  async verify(memoryId: string, expectedPayloadHash?: string): Promise<VerifyResult> {
    validateMemoryId(memoryId);
    try {
      const ref = await this.getRef(memoryId);
      if (expectedPayloadHash) {
        const expected = expectedPayloadHash.startsWith("0x") ? expectedPayloadHash.slice(2) : expectedPayloadHash;
        const stored = ref.payload_hash.startsWith("0x") ? ref.payload_hash.slice(2) : ref.payload_hash;
        if (expected !== stored) {
          return { valid: false, reason: "payload_hash mismatch" };
        }
      }
      if (!ref.contract_tx_hash) {
        return { valid: false, reason: "no contract_tx_hash" };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, reason: String(e) };
    }
  }

  /**
   * Flush pending events into a Merkle batch checkpoint immediately.
   * Requires MEMORA_BATCHING_ENABLED=true on the indexer.
   * Useful in demos and tests to force a checkpoint without waiting for the timer.
   */
  async flush(): Promise<FlushResult> {
    const headers: Record<string, string> = {};
    if (this.config.writeSecret) {
      headers["Authorization"] = `Bearer ${this.config.writeSecret}`;
    }
    const res = await fetch(`${this.config.indexerBaseUrl.replace(/\/$/, "")}${this.paths().batchFlush}`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(err.error || String(err));
    }
    return res.json() as Promise<FlushResult>;
  }

  /** Only internally constructed protected API routes may carry the API key. */
  private fetchApiRead(path: string): Promise<Response> {
    const base = new URL(this.readApiBaseUrl);
    const url = new URL(`${this.readApiBaseUrl}${path}`);
    const expectedPath = base.pathname.replace(/\/+$/, "") + path.split("?")[0];
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
        base.search || base.hash || url.origin !== base.origin || url.pathname !== expectedPath) {
      throw new Error("Invalid Memora API read URL");
    }
    const headers: Record<string, string> = {};
    if (this.config.writeSecret) {
      headers["Authorization"] = `Bearer ${this.config.writeSecret}`;
    }
    // Reject all redirects, including same-origin redirects to non-API routes.
    // Content and key-broker fetches must never reuse these headers.
    return fetch(url.href, { headers, redirect: "error" });
  }

  private async getRef(memoryId: string): Promise<MemoryRef> {
    const res = await this.fetchApiRead(this.paths().memory(memoryId));
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Memory not found: ${memoryId}`);
      }
      throw new Error(`Indexer error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
}
