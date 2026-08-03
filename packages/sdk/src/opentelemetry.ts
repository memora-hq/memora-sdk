import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Memora } from "./tracer.js";

export type MemoraSpanDropReason = "queue_full" | "write_failed" | "shutdown";

export interface MemoraSpanProcessorOptions {
  memora: Memora;
  shouldCapture?: (span: ReadableSpan) => boolean;
  attributeAllowlist?: string[];
  maxQueueSize?: number;
  onDrop?: (span: ReadableSpan, reason: MemoraSpanDropReason, error?: unknown) => void;
}

function hrTimeToMilliseconds(value: readonly [number, number]): number {
  return value[0] * 1_000 + value[1] / 1_000_000;
}

function serializableAttribute(value: unknown): string | number | boolean | Array<string | number | boolean> | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
    return value as Array<string | number | boolean>;
  }
  return undefined;
}

/**
 * Map selected OpenTelemetry spans into Memora evidence events.
 * This bridge is intentionally not a general OTLP receiver.
 */
export function createMemoraSpanProcessor(options: MemoraSpanProcessorOptions): SpanProcessor {
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? 256);
  const allowlist = new Set(options.attributeAllowlist ?? []);
  const queue: ReadableSpan[] = [];
  const eventIds = new Map<string, string>();
  const idleWaiters = new Set<() => void>();
  let draining = false;
  let stopped = false;

  const notifyIdle = () => {
    if (queue.length > 0 || draining) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const span = queue.shift()!;
        const context = span.spanContext();
        const parentSpanId = span.parentSpanContext?.spanId;
        const selectedAttributes: Record<string, unknown> = {};
        for (const key of allowlist) {
          const value = serializableAttribute(span.attributes[key]);
          if (value !== undefined) selectedAttributes[key] = value;
        }

        try {
          const receipt = await options.memora.recordEvent(
            `otel:${context.traceId}`,
            "otel_span",
            {
              span_name: span.name,
              span_kind: span.kind,
              span_id: context.spanId,
              ...(parentSpanId && { parent_span_id: parentSpanId }),
              started_at_ms: hrTimeToMilliseconds(span.startTime),
              duration_ms: hrTimeToMilliseconds(span.duration),
              status_code: span.status.code,
              ...(span.status.message && { status_message: span.status.message }),
              attributes: selectedAttributes,
              instrumentation_scope: span.instrumentationScope.name,
            },
            parentSpanId && eventIds.has(parentSpanId) ? [eventIds.get(parentSpanId)!] : [],
          );
          eventIds.set(context.spanId, receipt.event_id);
        } catch (error) {
          options.onDrop?.(span, "write_failed", error);
        }
      }
    } finally {
      draining = false;
      notifyIdle();
    }
  };

  const waitUntilIdle = () => {
    if (queue.length === 0 && !draining) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  };

  return {
    onStart(_span: Span, _parentContext: Context) {},
    onEnd(span: ReadableSpan) {
      if (stopped) {
        options.onDrop?.(span, "shutdown");
        return;
      }
      if (span.attributes["memora.internal"] === true || span.instrumentationScope.name.startsWith("@memora-hq/memora")) return;
      if (options.shouldCapture && !options.shouldCapture(span)) return;
      if (queue.length >= maxQueueSize) {
        options.onDrop?.(span, "queue_full");
        return;
      }
      queue.push(span);
      void drain();
    },
    async forceFlush() {
      await drain();
      await waitUntilIdle();
    },
    async shutdown() {
      stopped = true;
      await drain();
      await waitUntilIdle();
      eventIds.clear();
    },
  };
}
