/**
 * Hosted evidence export container + pure offline verifier (Foundation Slice 10).
 *
 * Distinct from memora.local.bundle. Cryptographic claims are recomputed from
 * preserved originals under a recipient-pinned trust policy. Exported keys and
 * governance rows are never automatically trusted.
 */

import { createHash } from "node:crypto";
import {
  canonicalizePayload,
  hashPayload,
  verifyAgentSignature,
  verifyOriginalEvent,
  EVENT_ID_PROFILES,
  type MemoryCommit,
  type MemoryPayload,
} from "@memora-hq/memora-protocol";

export const HOSTED_EXPORT_FORMAT = "memora.hosted.export" as const;
export const HOSTED_EXPORT_VERSION = 1 as const;
export const MAX_HOSTED_EXPORT_BYTES = 32 * 1024 * 1024;

export type ClaimOutcome = "pass" | "fail" | "indeterminate" | "not_applicable";

export interface HostedExportClaim {
  id: string;
  label: string;
  outcome: ClaimOutcome;
  /** Cryptographic vs operational assertion. */
  kind: "cryptographic" | "authorization" | "operational" | "structural";
  detail?: string;
}

/** Append-only signer lifecycle row included as evidence material (not auto-trusted). */
export interface HostedSignerLifecycleEvidence {
  event_id: string;
  agent_id: string;
  workspace_id: string;
  signer_address: string;
  action: "register" | "revoke";
  effective_at: string;
  authority: "workspace_admin" | "hedera_registry" | "legacy_import";
  tx_hash: string | null;
  authorized_by: string | null;
  replaces_signer: string | null;
}

export interface HostedExportEventV1 {
  memory_id: string;
  /** Hosted originals acceptance time (ISO). Used only with trusted governance. */
  accepted_at: string | null;
  artifact_sha256: string;
  /** HostedOriginalV1 JSON bytes, base64. */
  artifact_bytes_b64: string;
  /**
   * Optional disclosed plaintext. Trusted only when hash matches payload_hash.
   * Absence is not a crypto failure.
   */
  disclosed_payload?: MemoryPayload | null;
}

/**
 * Versioned hosted evidence-export container.
 * Envelope is not signed; trust comes from recomputed originals + recipient pins.
 */
export interface HostedEvidenceExportV1 {
  format: typeof HOSTED_EXPORT_FORMAT;
  version: typeof HOSTED_EXPORT_VERSION;
  exported_at?: string;
  scope: {
    root_memory_ids: string[];
    /** Whether parent originals were requested into the export. */
    include_parents: boolean;
  };
  events: HostedExportEventV1[];
  /**
   * Historical governance material. Never treated as authority unless the
   * recipient's trust policy explicitly opts in.
   */
  governance: {
    agent_signer_lifecycle: HostedSignerLifecycleEvidence[];
  };
}

export interface HostedTrustPolicy {
  /** Required: independently pinned operator/issuer address. */
  expectedOperatorSigner: string;
  /**
   * Optional: agent_id → allowed agent signer addresses.
   * When present, authorization is evaluated against this pin (not export contents alone).
   */
  expectedAgentSigners?: Record<string, string[]>;
  /**
   * When true, evaluate agent_signer_lifecycle rows for historical authorization.
   * Rows remain untrusted attestation from the exporter unless the recipient
   * separately trusts that source.
   */
  trustExportedGovernance?: boolean;
  acceptedGovernanceAuthorities?: Array<HostedSignerLifecycleEvidence["authority"]>;
  /** Default true: fail parent_closure when parents are referenced but missing from export. */
  requireParentClosure?: boolean;
}

export interface HostedExportVerificationResult {
  valid: boolean;
  claims: HostedExportClaim[];
  eventCount: number;
}

const ZERO_TASK = "0x" + "0".repeat(64);

function claim(
  id: string,
  label: string,
  outcome: ClaimOutcome,
  kind: HostedExportClaim["kind"],
  detail?: string,
): HostedExportClaim {
  return { id, label, outcome, kind, ...(detail !== undefined ? { detail } : {}) };
}

function normalizeAddr(value: string): string {
  return value.trim().toLowerCase();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeArtifact(bytesB64: string): {
  ok: true;
  bytes: Buffer;
  commit: MemoryCommit;
  preimageB64: string;
  commitB64: string;
} | { ok: false; reason: string } {
  try {
    if (typeof bytesB64 !== "string" || !bytesB64) return { ok: false, reason: "missing artifact_bytes_b64" };
    const bytes = Buffer.from(bytesB64, "base64");
    if (bytes.toString("base64") !== bytesB64) return { ok: false, reason: "invalid artifact base64" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const artifact = JSON.parse(text) as Record<string, unknown>;
    if (artifact.artifact_version !== 1) return { ok: false, reason: "unsupported artifact_version" };
    if (typeof artifact.commit_bytes_b64 !== "string" || typeof artifact.event_id_preimage_b64 !== "string") {
      return { ok: false, reason: "artifact missing commit or preimage" };
    }
    const commitText = Buffer.from(artifact.commit_bytes_b64, "base64").toString("utf8");
    const commit = JSON.parse(commitText) as MemoryCommit;
    return {
      ok: true,
      bytes,
      commit,
      preimageB64: artifact.event_id_preimage_b64,
      commitB64: artifact.commit_bytes_b64,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function authorizedAt(
  rows: HostedSignerLifecycleEvidence[],
  agentId: string,
  signer: string,
  at: string,
  authorities: Set<string>,
): boolean | null {
  const target = normalizeAddr(signer);
  const relevant = rows
    .filter((r) => r.agent_id === agentId && normalizeAddr(r.signer_address) === target)
    .filter((r) => authorities.has(r.authority))
    .filter((r) => Date.parse(r.effective_at) <= Date.parse(at))
    .sort((a, b) => {
      const ta = Date.parse(a.effective_at) - Date.parse(b.effective_at);
      return ta !== 0 ? ta : a.event_id.localeCompare(b.event_id);
    });
  if (relevant.length === 0) return null;
  let enabled = false;
  for (const row of relevant) {
    if (row.action === "register") enabled = true;
    if (row.action === "revoke") enabled = false;
  }
  return enabled;
}

/** Parse and structurally validate a hosted export file (no crypto yet). */
export function parseHostedEvidenceExport(input: string | Uint8Array): HostedEvidenceExportV1 {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_HOSTED_EXPORT_BYTES) {
    throw new Error("hosted export exceeds size limit");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text) as HostedEvidenceExportV1;
  if (parsed.format !== HOSTED_EXPORT_FORMAT) throw new Error("unsupported hosted export format");
  if (parsed.version !== HOSTED_EXPORT_VERSION) throw new Error("unsupported hosted export version");
  if (!parsed.scope || !Array.isArray(parsed.scope.root_memory_ids) || typeof parsed.scope.include_parents !== "boolean") {
    throw new Error("invalid hosted export scope");
  }
  if (!Array.isArray(parsed.events)) throw new Error("invalid hosted export events");
  if (!parsed.governance || !Array.isArray(parsed.governance.agent_signer_lifecycle)) {
    throw new Error("invalid hosted export governance");
  }
  for (const event of parsed.events) {
    if (!event || typeof event.memory_id !== "string" || typeof event.artifact_sha256 !== "string" ||
        typeof event.artifact_bytes_b64 !== "string") {
      throw new Error("invalid hosted export event");
    }
  }
  return parsed;
}

/**
 * Pure offline verifier. No network. Recipient must pin operator (and optionally agent) trust.
 * Never treats DB flags or export-embedded keys as authority by themselves.
 */
export function verifyHostedEvidenceExport(
  exported: HostedEvidenceExportV1 | string | Uint8Array,
  policy: HostedTrustPolicy,
): HostedExportVerificationResult {
  const claims: HostedExportClaim[] = [];
  let doc: HostedEvidenceExportV1;
  try {
    doc = typeof exported === "object" && exported !== null && "format" in (exported as object)
      ? (exported as HostedEvidenceExportV1)
      : parseHostedEvidenceExport(exported as string | Uint8Array);
    claims.push(claim("container_envelope", "hosted export envelope", "pass", "structural",
      `${doc.format}@${doc.version}`));
  } catch (e) {
    return {
      valid: false,
      eventCount: 0,
      claims: [claim("container_envelope", "hosted export envelope", "fail", "structural", (e as Error).message)],
    };
  }

  if (!policy?.expectedOperatorSigner?.trim()) {
    claims.push(claim("trust_policy", "recipient trust policy", "fail", "authorization",
      "expectedOperatorSigner is required — never trust keys from the export alone"));
    return { valid: false, claims, eventCount: doc.events.length };
  }
  claims.push(claim("trust_policy", "recipient trust policy", "pass", "authorization",
    "operator pin supplied by recipient"));

  if (doc.events.length === 0) {
    claims.push(claim("event_set", "export event set", "fail", "structural", "no events"));
    return { valid: false, claims, eventCount: 0 };
  }

  const byMemory = new Map<string, { event: HostedExportEventV1; commit: MemoryCommit }>();
  const requireParents = policy.requireParentClosure !== false;
  const authorities = new Set(
    policy.acceptedGovernanceAuthorities ?? ["workspace_admin", "hedera_registry", "legacy_import"],
  );

  let allCryptoOk = true;

  for (const event of doc.events) {
    const decoded = decodeArtifact(event.artifact_bytes_b64);
    if (!decoded.ok) {
      claims.push(claim(`artifact:${event.memory_id}`, "original artifact decode", "fail", "structural", decoded.reason));
      allCryptoOk = false;
      continue;
    }
    if (sha256Hex(decoded.bytes) !== event.artifact_sha256.toLowerCase().replace(/^0x/, "")) {
      claims.push(claim(`artifact_hash:${event.memory_id}`, "artifact sha256", "fail", "cryptographic",
        "artifact_bytes do not match artifact_sha256"));
      allCryptoOk = false;
      continue;
    }
    claims.push(claim(`artifact:${event.memory_id}`, "original artifact decode", "pass", "structural"));

    if (decoded.commit.memory_id !== event.memory_id) {
      claims.push(claim(`memory_bind:${event.memory_id}`, "memory_id binding", "fail", "structural",
        "export memory_id does not match commit.memory_id"));
      allCryptoOk = false;
      continue;
    }

    const original = {
      commit_bytes_b64: decoded.commitB64,
      event_id_preimage_b64: decoded.preimageB64,
    };
    const profiled = verifyOriginalEvent(original, {
      profile: EVENT_ID_PROFILES.hosted,
      expectedOperatorSigner: policy.expectedOperatorSigner,
    });
    if (!profiled.valid) {
      // Distinguish unknown/unsupported profile-ish failures from signature failures.
      const reason = profiled.reason ?? "original verification failed";
      const unknownProfile = /unsupported|unknown profile/i.test(reason);
      claims.push(claim(
        `operator_proof:${event.memory_id}`,
        "event ID + operator signature",
        "fail",
        "cryptographic",
        unknownProfile ? `unknown or unsupported profile: ${reason}` : reason,
      ));
      allCryptoOk = false;
      continue;
    }
    claims.push(claim(`operator_proof:${event.memory_id}`, "event ID + operator signature", "pass", "cryptographic",
      `operator ${policy.expectedOperatorSigner}`));

    const commit = decoded.commit;
    byMemory.set(event.memory_id, { event, commit });
    if (commit.event_id) byMemory.set(commit.event_id, { event, commit });

    // Agent signature cryptography (distinct from historical authorization).
    if (commit.agent_signer && commit.agent_signature) {
      const agentFields = {
        agent_id: commit.agent_id,
        agent_signer: commit.agent_signer,
        parent_event_ids: [...(commit.parent_event_ids ?? [])],
        payload_hash: commit.payload_hash,
        task_id: commit.task_id ?? ZERO_TASK,
      };
      const agentCrypto = verifyAgentSignature(agentFields, commit.agent_signature, commit.agent_signer);
      claims.push(claim(
        `agent_signature:${event.memory_id}`,
        "agent precommit signature",
        agentCrypto.valid ? "pass" : "fail",
        "cryptographic",
        agentCrypto.reason ?? commit.agent_signer,
      ));
      if (!agentCrypto.valid) allCryptoOk = false;

      // Authorization under recipient trust model.
      const pinned = policy.expectedAgentSigners?.[commit.agent_id];
      if (pinned && pinned.length > 0) {
        const ok = pinned.some((a) => normalizeAddr(a) === normalizeAddr(commit.agent_signer!));
        claims.push(claim(
          `agent_authorization:${event.memory_id}`,
          "agent signer authorization",
          ok ? "pass" : "fail",
          "authorization",
          ok ? "matches recipient-pinned agent signer" : "agent signer not in recipient pin set",
        ));
        if (!ok) allCryptoOk = false;
      } else if (policy.trustExportedGovernance) {
        if (!event.accepted_at) {
          claims.push(claim(
            `agent_authorization:${event.memory_id}`,
            "agent signer authorization",
            "indeterminate",
            "authorization",
            "governance trusted but accepted_at missing",
          ));
        } else {
          const auth = authorizedAt(
            doc.governance.agent_signer_lifecycle,
            commit.agent_id,
            commit.agent_signer,
            event.accepted_at,
            authorities,
          );
          if (auth === null) {
            claims.push(claim(
              `agent_authorization:${event.memory_id}`,
              "agent signer authorization",
              "indeterminate",
              "authorization",
              "no applicable governance rows under accepted authorities",
            ));
          } else {
            claims.push(claim(
              `agent_authorization:${event.memory_id}`,
              "agent signer authorization",
              auth ? "pass" : "fail",
              "authorization",
              auth
                ? "enabled at accepted_at under trusted exported governance"
                : "not authorized at accepted_at under trusted exported governance",
            ));
            if (!auth) allCryptoOk = false;
          }
        }
      } else {
        claims.push(claim(
          `agent_authorization:${event.memory_id}`,
          "agent signer authorization",
          "indeterminate",
          "authorization",
          "pin expectedAgentSigners or explicitly trustExportedGovernance — export keys are not auto-trusted",
        ));
      }
    } else {
      claims.push(claim(
        `agent_signature:${event.memory_id}`,
        "agent precommit signature",
        "not_applicable",
        "cryptographic",
        "no agent signature on original",
      ));
      claims.push(claim(
        `agent_authorization:${event.memory_id}`,
        "agent signer authorization",
        "not_applicable",
        "authorization",
        "no agent signer on original",
      ));
    }

    // Disclosed payload commitment (optional).
    if (event.disclosed_payload != null) {
      try {
        const recomputed = hashPayload(canonicalizePayload(event.disclosed_payload));
        const expected = commit.payload_hash.replace(/^0x/, "").toLowerCase();
        const ok = recomputed.toLowerCase() === expected;
        claims.push(claim(
          `disclosed_payload:${event.memory_id}`,
          "disclosed payload commitment",
          ok ? "pass" : "fail",
          "cryptographic",
          ok ? "disclosed plaintext matches payload_hash" : "disclosed plaintext contradicts payload_hash",
        ));
        if (!ok) allCryptoOk = false;
      } catch (e) {
        claims.push(claim(
          `disclosed_payload:${event.memory_id}`,
          "disclosed payload commitment",
          "fail",
          "cryptographic",
          (e as Error).message,
        ));
        allCryptoOk = false;
      }
    } else {
      claims.push(claim(
        `disclosed_payload:${event.memory_id}`,
        "disclosed payload commitment",
        "not_applicable",
        "cryptographic",
        "content not disclosed in export",
      ));
    }

    // Operational admission metadata is never treated as crypto proof.
    claims.push(claim(
      `admission_metadata:${event.memory_id}`,
      "admission / policy metadata",
      "not_applicable",
      "operational",
      "integrity_mode and DB verification flags are not cryptographic evidence",
    ));
  }

  // Parent closure + link integrity for roots.
  for (const rootId of doc.scope.root_memory_ids) {
    const root = byMemory.get(rootId);
    if (!root) {
      claims.push(claim(`root_present:${rootId}`, "root event present", "fail", "structural",
        "root_memory_id missing from export events"));
      allCryptoOk = false;
      continue;
    }
    const parents = root.commit.parent_event_ids ?? [];
    if (parents.length === 0) {
      claims.push(claim(`parent_closure:${rootId}`, "parent closure", "not_applicable", "structural",
        "no parents"));
      continue;
    }
    const missing = parents.filter((p) => !byMemory.has(p));
    if (missing.length > 0) {
      const outcome = requireParents ? "fail" : "indeterminate";
      claims.push(claim(
        `parent_closure:${rootId}`,
        "parent closure",
        outcome,
        "structural",
        `missing parent originals: ${missing.join(",")}`,
      ));
      if (requireParents) allCryptoOk = false;
    } else {
      claims.push(claim(`parent_closure:${rootId}`, "parent closure", "pass", "structural",
        `${parents.length} parent(s) present`));
      // Parent link integrity: each parent already passed operator proof when decoded.
      claims.push(claim(`parent_links:${rootId}`, "parent link integrity", "pass", "cryptographic",
        "included parents verified under pinned operator"));
    }
  }

  const hardFail = claims.some((c) => c.outcome === "fail");
  return {
    valid: allCryptoOk && !hardFail,
    claims,
    eventCount: doc.events.length,
  };
}
