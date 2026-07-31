import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  EncryptedPayloadBundle,
  LocalEventRecordV1,
  LocalEvidenceBundle,
  LocalEvidenceBundleV2,
  MemoryPayload,
} from "@smritheon/memora-protocol";
import { canonicalizePayload, decrypt, hashPayload, verifyEventEnvelope, verifyEventId } from "@smritheon/memora-protocol";
import type { LocalIdentity } from "./identity.js";
import { LocalEvidenceStore, localObjectId } from "./store.js";
import { verifyManifest } from "./manifest.js";
import { deriveLocalEncryptionKey } from "./session.js";
import type { LocalVerificationCheck, LocalVerificationResult } from "./verify.js";

/** How much of a bundle's content the exporter chose to reveal in plaintext. */
export type BundleDisclosure = "none" | "partial" | "full";

/**
 * A bundle is untrusted input the moment it arrives from someone else. Parsing is capped so a
 * hostile or corrupt file cannot exhaust memory in whichever process opened it.
 */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface ExportBundleOptions {
  /** `"all"`, or the event IDs whose payloads should travel in plaintext. Omit to export sealed. */
  disclose?: "all" | string[];
  /** Required whenever `disclose` is set — disclosure decrypts with the local evidence key. */
  identity?: LocalIdentity;
}

export interface ExportBundleResult {
  path: string;
  disclosure: BundleDisclosure;
  disclosedCount: number;
  eventCount: number;
  /** sha256 of the written file, so a receipt document can name the exact bundle it describes. */
  fingerprint: string;
}

export interface LocalBundleVerification extends LocalVerificationResult {
  /** Flat messages, kept for the CLI and for callers that only report failures. */
  errors: string[];
  signer: string;
  eventCount: number;
  disclosure: BundleDisclosure;
  disclosedCount: number;
}

function bundleDisclosed(bundle: LocalEvidenceBundle): Record<string, MemoryPayload> {
  return bundle.version === 2 ? bundle.disclosed ?? {} : {};
}

function classifyDisclosure(disclosedCount: number, eventCount: number): BundleDisclosure {
  if (disclosedCount === 0) return "none";
  return disclosedCount >= eventCount ? "full" : "partial";
}

async function collectDisclosures(
  events: LocalEventRecordV1[],
  payloads: Record<string, EncryptedPayloadBundle>,
  options: ExportBundleOptions,
): Promise<Record<string, MemoryPayload> | undefined> {
  if (!options.disclose) return undefined;
  if (!options.identity) throw new Error("A local identity is required to export a readable copy.");
  const requested = options.disclose === "all"
    ? new Set(events.map((event) => event.commit.event_id))
    : new Set(options.disclose);
  const key = deriveLocalEncryptionKey(options.identity);
  const disclosed: Record<string, MemoryPayload> = {};

  for (const event of events) {
    if (!requested.has(event.commit.event_id)) continue;
    requested.delete(event.commit.event_id!);
    const objectId = localObjectId(event.commit);
    const encrypted = payloads[objectId];
    if (!encrypted) throw new Error(`Local evidence is missing its stored content: ${objectId}`);
    const payload = JSON.parse(decrypt(encrypted, key)) as MemoryPayload;
    // Never publish plaintext that disagrees with the hash this device signed — that would hand
    // the recipient a claim the record itself contradicts.
    if (hashPayload(canonicalizePayload(payload)) !== event.commit.payload_hash) {
      throw new Error(`Local evidence is damaged and cannot be disclosed: ${objectId}`);
    }
    disclosed[objectId] = payload;
  }

  if (requested.size > 0) throw new Error(`This session has no such evidence record: ${[...requested][0]}`);
  return disclosed;
}

/**
 * Writes one session as a portable `.memora` bundle. Sealed by default: every payload travels as
 * ciphertext the recipient cannot read. With `disclose`, the chosen payloads travel in plaintext
 * as well, and a verifier can bind each of them back to the signed `payload_hash`.
 */
export async function exportLocalBundle(
  store: LocalEvidenceStore,
  sessionId: string,
  outputPath: string,
  options: ExportBundleOptions = {},
): Promise<ExportBundleResult> {
  const manifest = await store.readManifest(sessionId);
  const events = await store.readEvents(sessionId);
  const payloads: LocalEvidenceBundleV2["payloads"] = {};
  for (const event of events) {
    const objectId = localObjectId(event.commit);
    payloads[objectId] = await store.readPayload(sessionId, objectId);
  }
  const disclosed = await collectDisclosures(events, payloads, options);
  const bundle: LocalEvidenceBundleV2 = {
    format: "memora.local.bundle",
    version: 2,
    manifest,
    events,
    payloads,
    ...(disclosed ? { disclosed } : {}),
  };
  const serialized = JSON.stringify(bundle, null, 2) + "\n";
  await writeFile(outputPath, serialized, { mode: 0o600 });
  const disclosedCount = disclosed ? Object.keys(disclosed).length : 0;
  return {
    path: outputPath,
    disclosure: classifyDisclosure(disclosedCount, events.length),
    disclosedCount,
    eventCount: events.length,
    fingerprint: createHash("sha256").update(serialized).digest("hex"),
  };
}

function assertBundleShape(value: unknown): asserts value is LocalEvidenceBundle {
  const bundle = value as Partial<LocalEvidenceBundle> | null;
  if (!bundle || typeof bundle !== "object") throw new Error("unsupported Memora local bundle");
  if (bundle.format !== "memora.local.bundle") throw new Error("unsupported Memora local bundle");
  if (bundle.version !== 1 && bundle.version !== 2) throw new Error("unsupported Memora local bundle");
  if (!bundle.manifest || typeof bundle.manifest !== "object" || !Array.isArray(bundle.manifest.event_ids)) {
    throw new Error("this bundle has no readable execution manifest");
  }
  if (!Array.isArray(bundle.events)) throw new Error("this bundle has no readable event journal");
  if (!bundle.payloads || typeof bundle.payloads !== "object") throw new Error("this bundle has no readable content");
  const disclosed = (bundle as LocalEvidenceBundleV2).disclosed;
  if (disclosed !== undefined && (disclosed === null || typeof disclosed !== "object")) {
    throw new Error("this bundle has unreadable disclosed content");
  }
}

export async function readLocalBundle(path: string, maxBytes = MAX_BUNDLE_BYTES): Promise<LocalEvidenceBundle> {
  const { size } = await stat(path);
  if (size > maxBytes) {
    throw new Error(`This file is ${Math.round(size / 1_048_576)} MB — too large to be a Memora evidence bundle.`);
  }
  const bundle: unknown = JSON.parse(await readFile(path, "utf8"));
  assertBundleShape(bundle);
  return bundle;
}

/**
 * Verifies a bundle with no key, no account, and no network: manifest signature, event IDs, event
 * signatures, lineage, stored ciphertext, and — for any disclosed record — that the plaintext is
 * exactly what the signature covers.
 *
 * What this cannot establish is *who* the signer is. That is the caller's job to say out loud.
 */
export function verifyBundle(bundle: LocalEvidenceBundle): LocalBundleVerification {
  const errors: string[] = [];
  const checks: LocalVerificationCheck[] = [];
  const { manifest } = bundle;

  const manifestResult = verifyManifest(manifest);
  if (!manifestResult.valid) errors.push(manifestResult.reason ?? "manifest signature invalid");
  checks.push({
    name: "manifest signature",
    status: manifestResult.valid ? "passed" : "failed",
    detail: manifestResult.reason ?? manifest.signer,
  });

  const byId = new Map(bundle.events.map((event) => [event.commit.event_id, event]));
  const byObjectId = new Map(bundle.events.map((event) => [localObjectId(event.commit), event]));
  const allPresent = manifest.event_ids.every((id) => byId.has(id));
  checks.push({
    name: "manifest event set",
    status: allPresent ? "passed" : "failed",
    detail: `${byId.size}/${manifest.event_ids.length} events present`,
  });

  let eventsValid = true;
  for (const id of manifest.event_ids) {
    const event = byId.get(id);
    if (!event) { errors.push(`event missing: ${id}`); eventsValid = false; continue; }
    if (!verifyEventId(event.commit).valid) { errors.push(`event ID invalid: ${id}`); eventsValid = false; }
    if (!verifyEventEnvelope(event.commit, event.commit.parent_event_ids ?? [], manifest.signer).valid) {
      errors.push(`event signature invalid: ${id}`);
      eventsValid = false;
    }
    for (const parent of event.commit.parent_event_ids ?? []) {
      if (!byId.has(parent)) { errors.push(`parent missing: ${parent}`); eventsValid = false; }
    }
    const objectId = localObjectId(event.commit);
    const payload = bundle.payloads[objectId];
    if (!payload) { errors.push(`payload missing: ${objectId}`); eventsValid = false; }
    else if (createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== objectId) {
      errors.push(`payload modified: ${objectId}`);
      eventsValid = false;
    }
  }
  if (byId.size !== manifest.event_ids.length) {
    errors.push("bundle contains orphaned events");
    eventsValid = false;
  }
  checks.push({
    name: "event chain and payloads",
    status: eventsValid ? "passed" : "failed",
    detail: eventsValid
      ? "signatures, lineage and ciphertext verified"
      : "one or more records failed their signature, lineage, or ciphertext check",
  });

  const disclosed = bundleDisclosed(bundle);
  const disclosedEntries = Object.entries(disclosed);
  let disclosedCount = 0;
  let disclosureValid = true;
  for (const [objectId, payload] of disclosedEntries) {
    const event = byObjectId.get(objectId);
    if (!event) {
      errors.push(`disclosed content has no matching event: ${objectId}`);
      disclosureValid = false;
      continue;
    }
    let matches = false;
    try {
      matches = hashPayload(canonicalizePayload(payload)) === event.commit.payload_hash;
    } catch {
      matches = false;
    }
    if (matches) disclosedCount += 1;
    else {
      errors.push(`disclosed content does not match what was signed: ${objectId}`);
      disclosureValid = false;
    }
  }
  if (disclosedEntries.length > 0) {
    checks.push({
      name: "disclosed content",
      status: disclosureValid ? "passed" : "failed",
      detail: disclosureValid
        ? `${disclosedCount} of ${manifest.event_ids.length} records revealed and matched to their signed hashes`
        : "revealed content does not match the signed record",
    });
  }

  for (const warning of manifest.capture_warnings ?? []) {
    checks.push({ name: warning.code, status: "warning", detail: warning.message });
  }

  const valid = manifestResult.valid && allPresent && eventsValid && disclosureValid;
  return {
    valid,
    integrity: valid ? "verified" : "failed",
    identity: manifestResult.valid ? "self-issued-continuity-verified" : "failed",
    completeness: manifest.capture_status,
    anchoring: "local-only",
    checks,
    errors,
    signer: manifest.signer,
    eventCount: manifest.event_ids.length,
    disclosure: classifyDisclosure(disclosedCount, manifest.event_ids.length),
    disclosedCount,
  };
}

/** Plaintext for one event, when the exporter disclosed it. */
export function disclosedPayload(bundle: LocalEvidenceBundle, event: LocalEventRecordV1): MemoryPayload | undefined {
  return bundleDisclosed(bundle)[localObjectId(event.commit)];
}
