import { createHash } from "node:crypto";
import { canonicalizePayload, decrypt, hashPayload, verifyEventEnvelope, verifyEventId } from "@memora-hq/memora-protocol";
import type { LocalExecutionManifestV1 } from "@memora-hq/memora-protocol";
import type { LocalIdentity } from "./identity.js";
import { verifyManifest } from "./manifest.js";
import { deriveLocalEncryptionKey } from "./session.js";
import { LocalEvidenceStore, localObjectId } from "./store.js";

export interface LocalVerificationCheck {
  name: string;
  status: "passed" | "failed" | "warning";
  detail: string;
}

export interface LocalVerificationResult {
  valid: boolean;
  integrity: "verified" | "failed";
  identity: "self-issued-continuity-verified" | "failed";
  completeness: LocalExecutionManifestV1["capture_status"];
  anchoring: "local-only";
  checks: LocalVerificationCheck[];
}

export async function verifySession(
  store: LocalEvidenceStore,
  sessionId: string,
  identity?: LocalIdentity,
): Promise<LocalVerificationResult> {
  const checks: LocalVerificationCheck[] = [];
  const manifest = await store.readManifest(sessionId);
  const manifestResult = verifyManifest(manifest);
  checks.push({ name: "manifest signature", status: manifestResult.valid ? "passed" : "failed", detail: manifestResult.reason ?? manifest.signer });
  const events = await store.readEvents(sessionId);
  const byId = new Map(events.map((event) => [event.commit.event_id, event]));
  const allPresent = manifest.event_ids.every((id) => byId.has(id));
  checks.push({ name: "manifest event set", status: allPresent ? "passed" : "failed", detail: `${byId.size}/${manifest.event_ids.length} events present` });

  let eventsValid = true;
  for (const id of manifest.event_ids) {
    const event = byId.get(id);
    if (!event) { eventsValid = false; continue; }
    const eventIdResult = verifyEventId(event.commit);
    const parents = event.commit.parent_event_ids ?? [];
    const envelopeResult = verifyEventEnvelope(event.commit, parents, manifest.signer);
    if (!eventIdResult.valid || !envelopeResult.valid) eventsValid = false;
    for (const parent of parents) if (!byId.has(parent)) eventsValid = false;

    const objectId = localObjectId(event.commit);
    try {
      const encrypted = await store.readPayload(sessionId, objectId);
      const objectHash = createHash("sha256").update(JSON.stringify(encrypted)).digest("hex");
      if (objectHash !== objectId) eventsValid = false;
      if (identity) {
        const plaintext = decrypt(encrypted, deriveLocalEncryptionKey(identity));
        const payload = JSON.parse(plaintext);
        if (hashPayload(canonicalizePayload(payload)) !== event.commit.payload_hash) eventsValid = false;
      }
    } catch {
      eventsValid = false;
    }
  }
  checks.push({ name: "event chain and payloads", status: eventsValid ? "passed" : "failed", detail: identity ? "signatures, lineage, ciphertext and plaintext verified" : "signatures, lineage and ciphertext verified" });

  for (const warning of manifest.capture_warnings) {
    checks.push({ name: warning.code, status: "warning", detail: warning.message });
  }
  const valid = manifestResult.valid && allPresent && eventsValid;
  return {
    valid,
    integrity: valid ? "verified" : "failed",
    identity: manifestResult.valid ? "self-issued-continuity-verified" : "failed",
    completeness: manifest.capture_status,
    anchoring: "local-only",
    checks,
  };
}
