// ─── High-level integration API ─────────────────────────────────────────────
export {
  Memora,
  MEMORA_HOSTED_BASE_URL,
  type MemoraConfig,
  type IntegrityMode,
  type ProvenanceBackend,
  type TraceContext,
  type EventReceipt,
  type ReceiptOptions,
  type ExecutionReceipt,
  type ReceiptResult,
} from "./tracer.js";

// ─── Low-level cloud client ──────────────────────────────────────────────────
export {
  MemoraClient,
  type MemoraClientConfig,
  type WriteOptions,
  type WriteLineageOptions,
  type WriteReceipt,
  type VerifyResult,
} from "./client.js";

// ─── Shared types ────────────────────────────────────────────────────────────
export type {
  MemoryPayload,
  MemoryRef,
  MemoryCommit,
  AccessPolicySummary,
  EncryptedPayloadBundle,
  LineageEventType,
  ActorType,
} from "@smritheon/memora-protocol/dist/types.js";

// Aliases for backwards compatibility
export type { WriteOptions as WriteMemoryInput, WriteReceipt as WriteMemoryResult } from "./client.js";
export type { AccessPolicySummary as AccessPolicy } from "@smritheon/memora-protocol/dist/types.js";
