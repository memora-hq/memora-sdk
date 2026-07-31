/**
 * High-level Memora integration API.
 *
 * Wraps existing workflows with verifiable execution provenance in 5–10 lines.
 * Does not replace orchestration (Temporal, LangGraph, Dapr, etc.) — it adds
 * provenance, replay, and attestation alongside whatever you already run.
 */

import { hashPayload } from "@smritheon/memora-protocol/dist/crypto.js";
import { MemoraClient, type MemoraClientConfig, type WriteReceipt } from "./client.js";

/** Default gateway URL for the Memora hosted tier (api.getmemora.dev). */
export const MEMORA_HOSTED_BASE_URL = "https://api.getmemora.dev";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Integrity mode determines how execution events are anchored.
 *
 * - enterprise:    Append-only internal log. No chain dependency.
 * - anchored:      Internal execution + periodic chain anchoring.
 * - full_on_chain: Every event anchored on-chain with ecrecover verification.
 *                  (Default for Hedera deployment.)
 */
export type IntegrityMode = "enterprise" | "anchored" | "full_on_chain";

/**
 * Provenance backend (informational for the SDK; actual anchoring is
 * handled by the indexer).
 */
export type ProvenanceBackend = "local" | "hedera" | "ethereum" | "base" | "hybrid";

export interface MemoraConfig {
  /** Agent identity on the provenance network. */
  agentId: string;
  /** Per-agent API key (Bearer token). */
  apiKey?: string;

  /**
   * Gateway URL override. Points to a single Memora gateway that routes
   * internally to indexer and key-broker.
   *
   * Omit for the hosted tier — defaults to {@link MEMORA_HOSTED_BASE_URL}.
   * Self-hosted gateway: http://localhost:8787 or your internal gateway URL.
   */
  baseUrl?: string;

  /**
   * Direct indexer base URL for advanced self-hosted deployments (bypasses gateway).
   * Prefer `baseUrl` (gateway) for new projects. When set, overrides the hosted default.
   */
  endpoint?: string;
  /**
   * Direct key-broker base URL. Only needed when using endpoint directly.
   * Ignored when baseUrl is set.
   */
  keyBrokerEndpoint?: string;

  /** IPFS gateway base URL (read/decrypt only). */
  ipfsGatewayUrl?: string;
  /**
   * @deprecated Integrity mode is configured per agent in the Memora console
   * (workspace_agents.integrity_mode). This field is ignored.
   */
  mode?: IntegrityMode;
  /**
   * @deprecated Provenance backend is configured per workspace in the console.
   * This field is ignored.
   */
  backend?: ProvenanceBackend;
}

// ─── Trace context ───────────────────────────────────────────────────────────

/** Receipt returned after each provenance event is written. */
export interface EventReceipt {
  /** Unique event identifier (memory_id from the indexer). */
  event_id: string;
  /** SHA-256 hash of the event payload. */
  payload_hash: string;
  /** On-chain transaction hash (present once anchored; may be empty initially). */
  contract_tx_hash?: string;
}

/**
 * Execution trace context passed to the `trace()` callback.
 *
 * Call `trace.event()` to record provenance events within a run.
 * Parent event IDs are chained automatically — no manual tracking needed.
 */
export interface TraceContext {
  /** The unique execution run identifier (maps to mission_id). */
  readonly runId: string;
  /**
   * Record a signed provenance event.
   *
   * @param type  Event type label (e.g. "input_received", "decision_made")
   * @param data  Arbitrary serialisable context for this event
   * @returns     Receipt with event_id and payload_hash
   * @throws      If the indexer write fails (add .catch() to make it non-blocking)
   */
  event(type: string, data?: Record<string, unknown>): Promise<EventReceipt>;
}

// ─── Execution receipts (Memora Receipts) ────────────────────────────────────

export type ReceiptOptions = {
  provider?: string;
  model?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  eventType?: string;
  missionId?: string;
  parentIds?: string[];
  tags?: string[];
};

export type ExecutionReceipt = {
  /** User-facing lookup ID (maps to memory_id from the indexer). */
  execution_id: string;
  /** Deterministic event digest (maps to event_id when returned by indexer). */
  event_digest?: string;
  provider?: string;
  model?: string;
  input_hash?: string;
  output_hash?: string;
  payload_hash?: string;
  timestamp?: string;
  verification_status?: "recorded" | "verified" | "unverified";
  raw?: unknown;
};

export type ReceiptResult<T> = {
  result: T;
  receipt: ExecutionReceipt;
};

// ─── Internal helpers ────────────────────────────────────────────────────────

function generateRunId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

function hashData(data: unknown): string {
  return hashPayload(JSON.stringify(data ?? null));
}

function receiptFromWrite(r: WriteReceipt): EventReceipt {
  return {
    event_id: r.memory_id,
    payload_hash: r.payload_hash,
    contract_tx_hash: r.contract_tx_hash || undefined,
  };
}

let deprecatedConfigWarned = false;

function warnDeprecatedConfigFields(config: MemoraConfig): void {
  if (deprecatedConfigWarned) return;
  if (config.mode !== undefined || config.backend !== undefined) {
    deprecatedConfigWarned = true;
    console.warn(
      "[memora] MemoraConfig.mode and MemoraConfig.backend are deprecated and ignored. " +
        "Set integrity mode per agent and provenance backend per workspace in the Memora console.",
    );
  }
}

// ─── Memora class ────────────────────────────────────────────────────────────

/**
 * Memora integration layer.
 *
 * Adds verifiable execution provenance to existing workflows without replacing
 * your orchestration stack.
 *
 * @example
 * const memora = new Memora({
 *   agentId: "risk-agent",
 *   apiKey: process.env.MEMORA_API_KEY,
 *   endpoint: process.env.MEMORA_ENDPOINT,
 * });
 *
 * const result = await memora.trace("treasury-rebalance", async (trace) => {
 *   await trace.event("input_received", { input });
 *   const decision = await existingWorkflow(input);
 *   await trace.event("decision_made", { decision });
 *   return decision;
 * });
 */
export class Memora {
  private readonly _client: MemoraClient;
  private readonly config: MemoraConfig;

  constructor(config: MemoraConfig) {
    if (!config.agentId?.trim()) throw new Error("MemoraConfig.agentId is required");
    warnDeprecatedConfigFields(config);

    let clientConfig: MemoraClientConfig;

    const resolvedBaseUrl =
      config.baseUrl?.trim() ||
      (config.endpoint?.trim() ? undefined : MEMORA_HOSTED_BASE_URL);

    if (resolvedBaseUrl) {
      // Gateway mode: single URL, /v1/ paths (hosted default or explicit baseUrl)
      clientConfig = {
        indexerBaseUrl:   resolvedBaseUrl,
        keyBrokerBaseUrl: resolvedBaseUrl,
        ipfsGatewayUrl:   config.ipfsGatewayUrl,
        writeSecret:      config.apiKey,
        v1Routes:         true,
      };
    } else {
      // Legacy direct mode: separate indexer + key-broker URLs
      clientConfig = {
        indexerBaseUrl:   config.endpoint!,
        keyBrokerBaseUrl: config.keyBrokerEndpoint ?? config.endpoint!,
        ipfsGatewayUrl:   config.ipfsGatewayUrl,
        writeSecret:      config.apiKey,
        v1Routes:         false,
      };
    }

    this.config = config;
    this._client = new MemoraClient(clientConfig);
  }

  /**
   * Record one structured event without creating trace bookends.
   * Intended for instrumentation bridges that already own lifecycle events.
   */
  async recordEvent(
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
    parentEventIds: string[] = [],
  ): Promise<EventReceipt> {
    const receipt = await this._client.write({
      agentId: this.config.agentId,
      contentType: "application/json",
      content: data,
      lineage: {
        event_type: type,
        mission_id: runId,
        parent_ids: parentEventIds,
        actor_type: "agent",
        actor_id: this.config.agentId,
      },
    });
    return receiptFromWrite(receipt);
  }

  /** The underlying MemoraClient for low-level write/read/query/verify access. */
  get client(): MemoraClient {
    return this._client;
  }

  /**
   * Wrap an async function in a traced execution run.
   *
   * Automatically emits `run_started` and `run_completed` (or `run_failed`)
   * as bookend events. Call `trace.event()` within `fn` for intermediate events.
   * Parent event IDs are chained in sequence — no manual tracking needed.
   *
   * The return value of `fn` is always preserved. Errors are recorded then
   * re-thrown — the original error is never swallowed.
   *
   * @example
   * const result = await memora.trace("treasury-rebalance", async (trace) => {
   *   await trace.event("input_received", { input });
   *   const decision = await existingWorkflow(input);
   *   await trace.event("decision_made", { decision });
   *   return decision;
   * });
   * // Replay: memora replay verify --memory <event_id>
   */
  async trace<T>(runId: string, fn: (ctx: TraceContext) => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let lastEventId: string | undefined;

    const emit = async (type: string, data?: Record<string, unknown>): Promise<EventReceipt> => {
      const receipt = await this._client.write({
        agentId: this.config.agentId,
        contentType: "application/json",
        content: data ?? {},
        lineage: {
          event_type: type,
          mission_id: runId,
          parent_ids: lastEventId ? [lastEventId] : [],
          actor_type: "agent",
          actor_id: this.config.agentId,
        },
      });
      lastEventId = receipt.memory_id;
      return receiptFromWrite(receipt);
    };

    const ctx: TraceContext = {
      runId,
      event: emit,
    };

    // Bookend: run_started (best-effort — never blocks user function)
    await emit("run_started", { run_id: runId }).catch(() => {});

    try {
      const result = await fn(ctx);
      // Bookend: run_completed (best-effort)
      await emit("run_completed", {
        run_id: runId,
        duration_ms: Date.now() - startedAt,
      }).catch(() => {});
      return result;
    } catch (err) {
      // Bookend: run_failed — record then rethrow; never mask original error
      await emit("run_failed", {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      }).catch(() => {});
      throw err;
    }
  }

  /**
   * Wrap an existing async function with provenance recording.
   *
   * Records `workflow_started` before calling the function and
   * `workflow_completed` (or `workflow_failed`) after it returns.
   * Creates its own execution run — use `trace()` directly if you need
   * to embed this in a larger run context.
   *
   * @example
   * const analyseRisk = memora.wrap("risk-evaluation", existingAnalyser);
   * const result = await analyseRisk(portfolio);   // unchanged call site
   * // Replay: memora replay verify --memory <event_id>
   */
  wrap<TArgs extends unknown[], TReturn>(
    name: string,
    fn: (...args: TArgs) => Promise<TReturn>
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      const runId = generateRunId(name);
      return this.trace(runId, async (trace) => {
        // Best-effort: workflow events should not fail user's function
        await trace.event("workflow_started", {
          workflow: name,
          arg_count: args.length,
        }).catch(() => {});

        try {
          const result = await fn(...args);
          await trace.event("workflow_completed", { workflow: name }).catch(() => {});
          return result;
        } catch (err) {
          await trace.event("workflow_failed", {
            workflow: name,
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => {});
          throw err;
        }
      });
    };
  }

  /**
   * Wrap a tool call with provenance recording.
   *
   * Records `tool_called` (with input hash) and `tool_result` (with output hash
   * and duration_ms). On error records `tool_failed` then re-throws.
   * Essential for agent systems where individual tool executions need an
   * independent attestation trail.
   *
   * @example
   * const transfer = memora.tool("transfer_funds", async (args) => {
   *   return await bankTransfer(args);
   * });
   * const result = await transfer({ amount: 100, to: "0x..." });
   */
  tool<TInput, TOutput>(
    name: string,
    fn: (input: TInput) => Promise<TOutput>
  ): (input: TInput) => Promise<TOutput> {
    return async (input: TInput): Promise<TOutput> => {
      const runId = generateRunId(name);
      return this.trace(runId, async (trace) => {
        const startedAt = Date.now();

        await trace.event("tool_called", {
          tool: name,
          input_hash: hashData(input),
        }).catch(() => {});

        try {
          const output = await fn(input);
          await trace.event("tool_result", {
            tool: name,
            output_hash: hashData(output),
            duration_ms: Date.now() - startedAt,
          }).catch(() => {});
          return output;
        } catch (err) {
          await trace.event("tool_failed", {
            tool: name,
            error: err instanceof Error ? err.message : String(err),
            duration_ms: Date.now() - startedAt,
          }).catch(() => {});
          throw err;
        }
      });
    };
  }

  /**
   * Record an AI/API execution as a verifiable receipt.
   *
   * Runs `fn`, hashes optional input and the resolved output, then writes a single
   * `ai_receipt` event. Returns both the original result and an {@link ExecutionReceipt}.
   *
   * Does not prove a closed AI provider used a specific model — only that the
   * integrator recorded request/response hashes and metadata.
   *
   * @example
   * const { result, receipt } = await memora.receipt(async () => {
   *   return await client.responses.create({ model: "gpt-4.1", input: "..." });
   * }, { provider: "openai", model: "gpt-4.1", input: { input: "..." } });
   */
  async receipt<T>(fn: () => Promise<T>, opts?: ReceiptOptions): Promise<ReceiptResult<T>>;
  async receipt<T>(name: string, fn: () => Promise<T>, opts?: ReceiptOptions): Promise<ReceiptResult<T>>;
  async receipt<T>(
    nameOrFn: string | (() => Promise<T>),
    fnOrOpts?: (() => Promise<T>) | ReceiptOptions,
    maybeOpts?: ReceiptOptions,
  ): Promise<ReceiptResult<T>> {
    let name: string | undefined;
    let fn: () => Promise<T>;
    let opts: ReceiptOptions | undefined;

    if (typeof nameOrFn === "string") {
      name = nameOrFn;
      fn = fnOrOpts as () => Promise<T>;
      opts = maybeOpts;
    } else {
      fn = nameOrFn;
      opts = fnOrOpts as ReceiptOptions | undefined;
    }

    // TODO: optional ai_receipt_failed event on error (rethrow without masking).
    const result = await fn();

    const timestamp = new Date().toISOString();
    const input_hash = opts?.input !== undefined ? hashData(opts.input) : undefined;
    const output_hash = hashData(result);

    const write = await this._client.write({
      agentId: this.config.agentId,
      contentType: "application/json",
      content: {
        receipt_version: "1",
        kind: "ai_execution_receipt",
        ...(name && { name }),
        ...(input_hash && { input_hash }),
        ...(output_hash && { output_hash }),
      },
      meta: {
        ...(opts?.provider && { provider: opts.provider }),
        ...(opts?.model && { model: opts.model }),
        ...opts?.metadata,
      },
      tags: opts?.tags,
      lineage: {
        event_type: opts?.eventType ?? "ai_receipt",
        mission_id: opts?.missionId ?? name,
        parent_ids: opts?.parentIds ?? [],
        actor_type: "agent",
        actor_id: this.config.agentId,
      },
    });

    const receipt: ExecutionReceipt = {
      execution_id: write.memory_id,
      ...(write.event_id && { event_digest: write.event_id }),
      provider: opts?.provider,
      model: opts?.model,
      ...(input_hash && { input_hash }),
      output_hash,
      payload_hash: write.payload_hash,
      timestamp,
      verification_status: "recorded",
      raw: write,
    };

    return { result, receipt };
  }
}
