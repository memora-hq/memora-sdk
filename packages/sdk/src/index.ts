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

// ─── Agent precommit signing (verified mode) ─────────────────────────────────
export {
  createPrivateKeyAgentSigner,
  buildAgentPrecommitFields,
  signAgentPrecommit,
  absentTaskSentinel,
  type AgentEventSigner,
} from "./agentSigner.js";

// ─── Shared types ────────────────────────────────────────────────────────────
export type {
  MemoryPayload,
  MemoryRef,
  MemoryCommit,
  AccessPolicySummary,
  EncryptedPayloadBundle,
  LineageEventType,
  ActorType,
} from "@memora-hq/memora-protocol/dist/types.js";

// Aliases for backwards compatibility
export type { WriteOptions as WriteMemoryInput, WriteReceipt as WriteMemoryResult } from "./client.js";
export type { AccessPolicySummary as AccessPolicy } from "@memora-hq/memora-protocol/dist/types.js";
