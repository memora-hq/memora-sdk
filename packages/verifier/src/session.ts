import { createHash, randomBytes } from "node:crypto";
import { canonicalizePayload, computeEventId, encrypt, hashPayload, signEventEnvelope } from "@smritheon/memora-protocol";
import type {
  LocalCaptureSource,
  LocalCaptureStatus,
  LocalCaptureWarning,
  LocalEventRecordV1,
  LocalExecutionManifestV1,
  MemoryCommit,
  MemoryPayload,
} from "@smritheon/memora-protocol";
import type { LocalIdentity } from "./identity.js";
import { signManifest } from "./manifest.js";
import { LocalEvidenceStore } from "./store.js";

export interface LocalSessionOptions {
  store: LocalEvidenceStore;
  identity: LocalIdentity;
  captureRoot: string;
  captureSource?: string;
}

interface LocalSessionState {
  sessionId: string;
  startedAt: string;
  eventIds: string[];
  warnings: LocalCaptureWarning[];
}

function encryptionKey(identity: LocalIdentity): Buffer {
  return createHash("sha256").update("memora:local:encryption:v1\n" + identity.privateKey).digest();
}

export class LocalSession {
  readonly sessionId: string;
  private readonly startedAt: string;
  private readonly eventIds: string[];
  private readonly warnings: LocalCaptureWarning[];
  private finalized = false;

  constructor(private readonly options: LocalSessionOptions, state?: LocalSessionState) {
    this.sessionId = state?.sessionId ?? `local_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    this.startedAt = state?.startedAt ?? new Date().toISOString();
    this.eventIds = state ? [...state.eventIds] : [];
    this.warnings = state ? [...state.warnings] : [];
  }

  static async resume(options: LocalSessionOptions, sessionId: string): Promise<LocalSession> {
    const manifest = await options.store.readManifest(sessionId);
    return new LocalSession(options, {
      sessionId,
      startedAt: manifest.started_at,
      eventIds: manifest.event_ids,
      warnings: manifest.capture_warnings,
    });
  }

  async start(): Promise<void> {
    await this.options.store.initialize();
    await this.options.store.createSession(this.sessionId);
    await this.record("session_started", { session_id: this.sessionId }, "wrapper_observed");
    await this.persistManifest("partial");
  }

  warn(warning: LocalCaptureWarning): void {
    this.warnings.push(warning);
  }

  async record(type: string, content: Record<string, unknown>, source: LocalCaptureSource): Promise<string> {
    if (this.finalized) throw new Error("local session already finalized");
    const parentIds = this.eventIds.length ? [this.eventIds[this.eventIds.length - 1]] : [];
    const payload: MemoryPayload = {
      memora_version: "0.2",
      contentType: "application/json",
      content,
      event_type: type,
      mission_id: this.sessionId,
      parent_ids: parentIds,
      actor_type: "agent",
      actor_id: this.options.identity.agentId,
      meta: { capture_source: source },
    };
    const canonical = canonicalizePayload(payload);
    const payloadHash = hashPayload(canonical);
    const encrypted = encrypt(canonical, encryptionKey(this.options.identity));
    const serializedEncrypted = JSON.stringify(encrypted);
    const objectId = createHash("sha256").update(serializedEncrypted).digest("hex");
    const memoryId = `mem_${randomBytes(16).toString("hex")}`;
    const commit: MemoryCommit = {
      memory_id: memoryId,
      agent_id: this.options.identity.agentId,
      cid_ciphertext: `local:sha256:${objectId}`,
      payload_hash: payloadHash,
      schema_version: 1,
      event_type: type,
      mission_id: this.sessionId,
      parent_count: parentIds.length,
      parent_event_ids: parentIds,
      signer: this.options.identity.address,
      signature: null,
    };
    commit.event_id = computeEventId(commit);
    commit.signature = await signEventEnvelope(commit, parentIds, this.options.identity.privateKey);
    const record: LocalEventRecordV1 = {
      format: "memora.local.event",
      version: 1,
      observed_at: new Date().toISOString(),
      source,
      commit,
    };
    await this.options.store.putPayload(this.sessionId, objectId, encrypted);
    await this.options.store.appendEvent(this.sessionId, record);
    this.eventIds.push(commit.event_id);
    return commit.event_id;
  }

  async finish(status: LocalCaptureStatus, details: Record<string, unknown> = {}): Promise<LocalExecutionManifestV1> {
    if (this.finalized) throw new Error("local session already finalized");
    await this.record(status === "interrupted" ? "session_interrupted" : "session_completed", details, "wrapper_observed");
    this.finalized = true;
    return this.persistManifest(status, new Date().toISOString());
  }

  async checkpoint(status: LocalCaptureStatus = "partial"): Promise<LocalExecutionManifestV1> {
    if (this.finalized) throw new Error("local session already finalized");
    return this.persistManifest(status);
  }

  private async persistManifest(status: LocalCaptureStatus, completedAt?: string): Promise<LocalExecutionManifestV1> {
    const captureRootHash = createHash("sha256").update(this.options.captureRoot).digest("hex");
    const manifest: LocalExecutionManifestV1 = {
      format: "memora.local.execution",
      version: 1,
      session_id: this.sessionId,
      agent_id: this.options.identity.agentId,
      capture_source: this.options.captureSource ?? "process-wrapper",
      capture_root_hash: captureRootHash,
      started_at: this.startedAt,
      ...(completedAt ? { completed_at: completedAt } : {}),
      root_event_id: this.eventIds[0] ?? "",
      event_ids: [...this.eventIds],
      signer: this.options.identity.address,
      capture_status: status,
      capture_warnings: [...this.warnings],
      signature: null,
    };
    const signed = await signManifest(manifest, this.options.identity.privateKey);
    await this.options.store.writeManifest(this.sessionId, signed);
    return signed;
  }
}

export function deriveLocalEncryptionKey(identity: LocalIdentity): Buffer {
  return encryptionKey(identity);
}
