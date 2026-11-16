import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import {
  EVENT_ID_PROFILES,
  getEventIdPreimage,
  signEventEnvelope,
  signAgentEvent,
  hashPayload,
  canonicalizePayload,
  type MemoryCommit,
  type MemoryPayload,
} from "@memora-hq/memora-protocol";
import {
  parseHostedEvidenceExport,
  verifyHostedEvidenceExport,
  HOSTED_EXPORT_FORMAT,
  HOSTED_EXPORT_VERSION,
  type HostedEvidenceExportV1,
} from "./hostedExport.js";

const operator = new Wallet("0x" + "33".repeat(32));
const agentKey = "0x" + "44".repeat(32);
const agentWallet = new Wallet(agentKey);

const fixtures: Array<{ name: string; preimage: string; commit: MemoryCommit }> = JSON.parse(
  readFileSync(new URL("./fixtures/hosted-event-id-v1.json", import.meta.url), "utf8"),
);

function wrapArtifact(commit: MemoryCommit, preimage?: string): { artifact_bytes_b64: string; artifact_sha256: string } {
  const pre = preimage ?? getEventIdPreimage(commit, EVENT_ID_PROFILES.hosted).toString("utf8");
  const artifact = {
    artifact_version: 1,
    commit_bytes_b64: Buffer.from(JSON.stringify(commit)).toString("base64"),
    event_id_preimage_b64: Buffer.from(pre, "utf8").toString("base64"),
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  return {
    artifact_bytes_b64: bytes.toString("base64"),
    artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function liveCommit(parents: string[] = []): Promise<MemoryCommit> {
  const payload: MemoryPayload = { contentType: "application/json", content: { slice10: true } };
  const payload_hash = hashPayload(canonicalizePayload(payload));
  const agent_signature = await signAgentEvent({
    agent_id: "agent-slice10",
    agent_signer: agentWallet.address,
    parent_event_ids: [...parents].sort(),
    payload_hash,
    task_id: "0x" + "0".repeat(64),
  }, agentKey);
  const base: MemoryCommit = {
    memory_id: "0x" + "ab".repeat(32),
    agent_id: "agent-slice10",
    cid_ciphertext: "supabase://obj",
    payload_hash,
    schema_version: 1,
    signer: operator.address,
    signature: null as unknown as string,
    agent_signer: agentWallet.address,
    agent_signature,
    ...(parents.length ? { parent_count: parents.length, parent_event_ids: [...parents].sort() } : { parent_count: 0 }),
  };
  const preimage = getEventIdPreimage(base, EVENT_ID_PROFILES.hosted);
  const event_id = createHash("sha256").update(preimage).digest("hex");
  const unsigned = { ...base, event_id, signature: null };
  const signature = await signEventEnvelope(unsigned as MemoryCommit, [...(unsigned.parent_event_ids ?? [])], operator.privateKey);
  return { ...unsigned, signature } as MemoryCommit;
}

describe("hosted evidence export verifier", () => {
  it("verifies fixture original under pinned operator", () => {
    const v = fixtures[0];
    const art = wrapArtifact(v.commit, v.preimage);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [v.commit.memory_id], include_parents: false },
      events: [{
        memory_id: v.commit.memory_id,
        accepted_at: null,
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, { expectedOperatorSigner: v.commit.signer! });
    expect(result.claims.some((c) => c.id.startsWith("operator_proof:") && c.outcome === "pass")).toBe(true);
    expect(result.claims.some((c) => c.id.startsWith("agent_signature:") && c.outcome === "not_applicable")).toBe(true);
  });

  it("passes live signed export under pinned operator + agent", async () => {
    const commit = await liveCommit();
    const art = wrapArtifact(commit);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [commit.memory_id], include_parents: false },
      events: [{
        memory_id: commit.memory_id,
        accepted_at: "2026-01-01T00:00:00.000Z",
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, {
      expectedOperatorSigner: operator.address,
      expectedAgentSigners: { [commit.agent_id]: [agentWallet.address] },
    });
    expect(result.valid).toBe(true);
  });

  it("leaves agent authorization indeterminate without pins or trusted governance", async () => {
    const commit = await liveCommit();
    const art = wrapArtifact(commit);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [commit.memory_id], include_parents: false },
      events: [{
        memory_id: commit.memory_id,
        accepted_at: "2026-01-01T00:00:00.000Z",
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, { expectedOperatorSigner: operator.address });
    expect(result.claims.some((c) => c.id.startsWith("agent_authorization:") && c.outcome === "indeterminate")).toBe(true);
  });

  it("fails disclosed payload that contradicts commitment", async () => {
    const commit = await liveCommit();
    const art = wrapArtifact(commit);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [commit.memory_id], include_parents: false },
      events: [{
        memory_id: commit.memory_id,
        accepted_at: null,
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
        disclosed_payload: { contentType: "application/json", content: { tampered: true } },
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, { expectedOperatorSigner: operator.address });
    expect(result.valid).toBe(false);
    expect(result.claims.some((c) => c.id.startsWith("disclosed_payload:") && c.outcome === "fail")).toBe(true);
  });

  it("fails wrong operator pin", () => {
    const v = fixtures[0];
    const art = wrapArtifact(v.commit, v.preimage);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [v.commit.memory_id], include_parents: false },
      events: [{
        memory_id: v.commit.memory_id,
        accepted_at: null,
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, {
      expectedOperatorSigner: new Wallet("0x" + "55".repeat(32)).address,
    });
    expect(result.valid).toBe(false);
  });

  it("fails missing parent closure when required", async () => {
    const commit = await liveCommit(["missing-parent-ref"]);
    const art = wrapArtifact(commit);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [commit.memory_id], include_parents: true },
      events: [{
        memory_id: commit.memory_id,
        accepted_at: null,
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, { expectedOperatorSigner: operator.address });
    expect(result.valid).toBe(false);
    expect(result.claims.some((c) => c.id.startsWith("parent_closure:") && c.outcome === "fail")).toBe(true);
  });

  it("fails malformed container", () => {
    expect(() => parseHostedEvidenceExport("{}")).toThrow();
  });

  it("fails altered artifact hash", () => {
    const v = fixtures[0];
    const art = wrapArtifact(v.commit, v.preimage);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [v.commit.memory_id], include_parents: false },
      events: [{
        memory_id: v.commit.memory_id,
        accepted_at: null,
        artifact_sha256: "ff".repeat(32),
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    expect(verifyHostedEvidenceExport(doc, { expectedOperatorSigner: v.commit.signer! }).valid).toBe(false);
  });

  it("fails incorrect agent signer pin", async () => {
    const commit = await liveCommit();
    const art = wrapArtifact(commit);
    const doc: HostedEvidenceExportV1 = {
      format: HOSTED_EXPORT_FORMAT,
      version: HOSTED_EXPORT_VERSION,
      scope: { root_memory_ids: [commit.memory_id], include_parents: false },
      events: [{
        memory_id: commit.memory_id,
        accepted_at: null,
        artifact_sha256: art.artifact_sha256,
        artifact_bytes_b64: art.artifact_bytes_b64,
      }],
      governance: { agent_signer_lifecycle: [] },
    };
    const result = verifyHostedEvidenceExport(doc, {
      expectedOperatorSigner: operator.address,
      expectedAgentSigners: { [commit.agent_id]: [new Wallet("0x" + "66".repeat(32)).address] },
    });
    expect(result.valid).toBe(false);
  });
});
