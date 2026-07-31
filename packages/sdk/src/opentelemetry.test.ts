import { describe, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createMemoraSpanProcessor } from "./opentelemetry.js";
import type { Memora } from "./tracer.js";

function span(id: string, parentId?: string): ReadableSpan {
  return {
    name: `span-${id}`,
    kind: 0,
    spanContext: () => ({ traceId: "1".repeat(32), spanId: id, traceFlags: 1 }),
    parentSpanContext: parentId ? { traceId: "1".repeat(32), spanId: parentId, traceFlags: 1 } : undefined,
    startTime: [1, 0],
    duration: [0, 5_000_000],
    status: { code: 1 },
    attributes: { "http.request.method": "POST", secret: "excluded" },
    links: [],
    events: [],
    ended: true,
    resource: {} as ReadableSpan["resource"],
    instrumentationScope: { name: "test-instrumentation" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

describe("OpenTelemetry bridge", () => {
  it("captures allowlisted attributes and preserves parent evidence lineage", async () => {
    let count = 0;
    const recordEvent = vi.fn(async () => ({
      event_id: `event-${++count}`,
      payload_hash: "a".repeat(64),
    }));
    const processor = createMemoraSpanProcessor({
      memora: { recordEvent } as unknown as Memora,
      attributeAllowlist: ["http.request.method"],
    });
    processor.onEnd(span("0000000000000001"));
    processor.onEnd(span("0000000000000002", "0000000000000001"));
    await processor.forceFlush();

    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(recordEvent.mock.calls[0][2].attributes).toEqual({ "http.request.method": "POST" });
    expect(recordEvent.mock.calls[1][3]).toEqual(["event-1"]);
  });

  it("does not recursively capture Memora internal spans", async () => {
    const recordEvent = vi.fn();
    const processor = createMemoraSpanProcessor({ memora: { recordEvent } as unknown as Memora });
    const internal = span("0000000000000001") as unknown as { attributes: Record<string, unknown> };
    internal.attributes["memora.internal"] = true;
    processor.onEnd(internal as unknown as ReadableSpan);
    await processor.forceFlush();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
