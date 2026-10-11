import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentTraceCollector } from "./agent-trace-collector.js";

// 验证用户取消时根 Span、未完成模型 Span 和部分回答载荷仍可写入 Trace。
void describe("AgentTraceCollector cancellation", () => {
  // 将仍在运行的 Span 收尾为取消状态，并保留已生成的部分回答。
  void it("keeps partial model output in a cancelled trace", () => {
    const collector = new AgentTraceCollector();
    const modelSpan = collector.createSpan({
      name: "model.chat.stream",
      kind: "model",
      parentSpanId: collector.root.record.id,
    });
    modelSpan.addPayload("partial_response", { content: "已收到的回答" });

    const reason = new DOMException("用户已停止生成", "AbortError");
    collector.finishRunningSpans("cancelled", reason);
    collector.finishRoot("cancelled", reason);
    const rows = collector.toDatabaseRows();

    assert.equal(collector.root.record.status, "cancelled");
    assert.equal(modelSpan.record.status, "cancelled");
    assert.equal(modelSpan.record.error, "用户已停止生成");
    assert.deepEqual(rows.payloads, [
      {
        spanId: modelSpan.record.id,
        payloadType: "partial_response",
        payload: { content: "已收到的回答" },
      },
    ]);
  });
});
