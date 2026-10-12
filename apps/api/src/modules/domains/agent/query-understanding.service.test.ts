import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JevIntentService,
  QUERY_INTENTS,
  type JevIntentClassification,
  type JevIntentRequest,
  type QueryIntentProbabilities,
} from "./jev-intent.service.js";
import {
  QueryUnderstandingService,
  matchIntentRule,
  type QueryUnderstandingInput,
} from "./query-understanding.service.js";
import {
  AgentTraceCollector,
  runWithAgentTraceCollector,
} from "../../../shared/tracing/agent-trace-collector.js";

// 为指定意图生成全量概率，未覆盖项保持低置信度。
function probabilities(
  overrides: Partial<QueryIntentProbabilities> = {},
): QueryIntentProbabilities {
  return Object.fromEntries(
    QUERY_INTENTS.map((intent) => [intent, overrides[intent] ?? 0.05]),
  ) as QueryIntentProbabilities;
}

// 构造 Jev 结构化响应替身，避免查询理解测试访问 OpenRouter。
class JevIntentStub extends JevIntentService {
  calls = 0;
  request: JevIntentRequest | null = null;
  result: JevIntentClassification = {
    model: "typesafe/jev-1.13-test",
    probabilities: probabilities({ knowledge_qa: 0.94 }),
    usage: { input_tokens: 80, output_tokens: 24 },
  };
  failure: Error | null = null;

  // 捕获传给分类器的消息并返回可控概率。
  override classify(input: JevIntentRequest): Promise<JevIntentClassification> {
    this.calls += 1;
    this.request = input;
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(this.result);
  }
}

// 构造有最近会话上下文和授权知识库的分类输入。
function input(query = "那需要什么材料？"): QueryUnderstandingInput {
  return {
    query,
    recentMessages: [
      { role: "user", content: "出差回来怎么报销？" },
      { role: "assistant", content: "通过报销系统申请。" },
    ],
    conversationSummary: null,
    accessibleKnowledgeBases: [{ id: "hr", name: "人事知识库", description: "员工制度" }],
  };
}

void describe("Jev intent classification", () => {
  void it("calls the TypeSafe SDK through OpenRouter's System One endpoint", async () => {
    const originalApiKey = process.env["OPENROUTER_API_KEY"];
    const originalModel = process.env["JEV_INTENT_MODEL"];
    const originalFetch = globalThis.fetch;
    const expectedProbabilities = probabilities({ knowledge_qa: 0.96, document_catalog: 0.68 });
    const capturedRequestBody: { value: string | null } = { value: null };

    process.env["OPENROUTER_API_KEY"] = "test-openrouter-key";
    process.env["JEV_INTENT_MODEL"] = "jev-1.13";
    globalThis.fetch = (url, init) => {
      const requestUrl = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      assert.equal(requestUrl, "https://openrouter.ai/api/v1/systemone");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-openrouter-key");
      if (typeof init?.body !== "string") throw new Error("System One request body is missing");
      capturedRequestBody.value = init.body;
      const answers = Object.fromEntries(
        QUERY_INTENTS.map((intent) => [
          intent,
          { type: "noul", noul: expectedProbabilities[intent] },
        ]),
      );
      return Promise.resolve(
        Response.json({
          model: "typesafe/jev-1.13-test",
          answers,
          usage: { input_tokens: 80, output_tokens: 24, cost: 0.00003 },
        }),
      );
    };

    try {
      const collector = new AgentTraceCollector();
      const result = await runWithAgentTraceCollector(collector, () =>
        new JevIntentService().classify(input()),
      );
      assert.ok(capturedRequestBody.value);
      const requestBody = JSON.parse(capturedRequestBody.value) as Record<string, unknown>;
      assert.deepEqual(result.probabilities, expectedProbabilities);
      assert.equal(result.model, "typesafe/jev-1.13-test");
      assert.deepEqual(result.usage, { input_tokens: 80, output_tokens: 24 });
      assert.equal(requestBody["model"], "jev-1.13");
      assert.ok(requestBody["questions"]);
      assert.equal(JSON.stringify(requestBody).includes("accessibleKnowledgeBases"), false);
      const traceRows = collector.toDatabaseRows();
      const jevSpan = traceRows.spans.find((span) => span.name === "model.jev.intent");
      assert.ok(jevSpan);
      assert.equal(jevSpan.parentSpanId, collector.root.record.id);
      assert.equal(jevSpan.inputTokens, 80);
      const responsePayload = traceRows.payloads.find(
        (payload) => payload.spanId === jevSpan.id && payload.payloadType === "response",
      );
      assert.equal(
        (responsePayload?.payload as { usage?: { openRouterCost?: number } }).usage?.openRouterCost,
        0.00003,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = originalApiKey;
      if (originalModel === undefined) delete process.env["JEV_INTENT_MODEL"];
      else process.env["JEV_INTENT_MODEL"] = originalModel;
    }
  });

  void it("returns multiple independent intents and preserves every probability", async () => {
    const jev = new JevIntentStub();
    jev.result.probabilities = probabilities({
      knowledge_qa: 0.96,
      document_catalog: 0.82,
      general_generation: 0.04,
    });
    const plan = await new QueryUnderstandingService(jev).understand(
      input("列出文档目录，并说明报销需要哪些材料"),
    );

    assert.deepEqual(plan.intents, ["knowledge_qa", "document_catalog"]);
    assert.equal(plan.isMixed, true);
    assert.equal(plan.needsRetrieval, true);
    assert.equal(plan.route, "retrieve");
    assert.equal(plan.intentScores.document_catalog, 0.82);
    assert.equal(plan.trace.source, "jev");
    assert.equal(plan.trace.model, "typesafe/jev-1.13-test");
    assert.equal(jev.calls, 1);
  });

  void it("keeps a single catalog route and resolves only one named authorized library", async () => {
    const jev = new JevIntentStub();
    jev.result.probabilities = probabilities({ document_catalog: 0.93 });
    const plan = await new QueryUnderstandingService(jev).understand(
      input("请列出人事知识库的文档名称"),
    );

    assert.equal(plan.route, "catalog");
    assert.deepEqual(plan.requestedKnowledgeBaseIds, ["hr"]);
    assert.deepEqual(plan.intents, ["document_catalog"]);
    assert.equal(plan.isMixed, false);
    assert.equal(jev.calls, 1);
  });

  void it("maps access scope and capability labels to existing single-route paths", async () => {
    const jev = new JevIntentStub();
    const service = new QueryUnderstandingService(jev);
    for (const [intent, route, query] of [
      ["access_scope", "scope", "我可以访问哪些知识库？"],
      ["assistant_capability", "capability", "你能做什么？"],
      ["general_generation", "social", "你好"],
      ["conversation_transform", "direct", "总结上一条回答"],
    ] as const) {
      jev.result.probabilities = probabilities({ [intent]: 0.9 });
      const plan = await service.understand(input(query));
      assert.equal(plan.route, route, query);
      assert.deepEqual(plan.intents, [intent]);
      assert.equal(plan.needsRetrieval, false);
    }
    assert.equal(jev.calls, 4);
  });

  void it("retrieves when the request is unclear or Jev is unavailable", async () => {
    const unclearJev = new JevIntentStub();
    unclearJev.result.probabilities = probabilities({ unclear: 0.9 });
    const unclearPlan = await new QueryUnderstandingService(unclearJev).understand(input("那呢？"));
    assert.deepEqual(unclearPlan.intents, ["unclear"]);
    assert.equal(unclearPlan.needsRetrieval, true);

    const unavailableJev = new JevIntentStub();
    unavailableJev.failure = new Error("connection unavailable");
    const degradedPlan = await new QueryUnderstandingService(unavailableJev).understand(input());
    assert.equal(degradedPlan.trace.source, "degraded");
    assert.equal(degradedPlan.trace.model, null);
    assert.equal(degradedPlan.needsRetrieval, true);
    assert.ok(Object.values(degradedPlan.intentScores).every((score) => score === null));
  });

  void it("applies the configured threshold without losing raw scores", async () => {
    const originalThreshold = process.env["JEV_INTENT_THRESHOLD"];
    process.env["JEV_INTENT_THRESHOLD"] = "0.7";
    const jev = new JevIntentStub();
    jev.result.probabilities = probabilities({ access_scope: 0.71, document_catalog: 0.69 });

    try {
      const plan = await new QueryUnderstandingService(jev).understand(input("看看目录和权限"));
      assert.deepEqual(plan.intents, ["access_scope"]);
      assert.equal(plan.intentScores.document_catalog, 0.69);
      assert.equal(plan.trace.threshold, 0.7);
    } finally {
      if (originalThreshold === undefined) delete process.env["JEV_INTENT_THRESHOLD"];
      else process.env["JEV_INTENT_THRESHOLD"] = originalThreshold;
    }
  });

  void it("does not let mixed greetings bypass Jev classification", async () => {
    const jev = new JevIntentStub();
    jev.result.probabilities = probabilities({ knowledge_qa: 0.9, general_generation: 0.78 });
    const query = "你好，报销流程是什么？";
    assert.equal(matchIntentRule(input(query)), null);
    const plan = await new QueryUnderstandingService(jev).understand(input(query));
    assert.deepEqual(plan.intents, ["knowledge_qa", "general_generation"]);
    assert.equal(plan.needsRetrieval, true);
    assert.equal(jev.calls, 1);
  });

  void it("does not allow classification to select an unauthorized knowledge base", async () => {
    const jev = new JevIntentStub();
    jev.result.probabilities = probabilities({ document_catalog: 0.91 });
    const query = "请列出秘密知识库的文档目录";
    const plan = await new QueryUnderstandingService(jev).understand(input(query));
    assert.equal(plan.route, "catalog");
    assert.deepEqual(plan.requestedKnowledgeBaseIds, []);
    assert.equal(jev.calls, 1);
    assert.equal(matchIntentRule(input(query)), null);
  });

  void it("rejects an invalid probability threshold instead of silently changing policy", async () => {
    const originalThreshold = process.env["JEV_INTENT_THRESHOLD"];
    process.env["JEV_INTENT_THRESHOLD"] = "1.2";
    const jev = new JevIntentStub();
    try {
      await assert.rejects(
        new QueryUnderstandingService(jev).understand(input()),
        /JEV_INTENT_THRESHOLD/,
      );
      assert.equal(jev.calls, 0);
    } finally {
      if (originalThreshold === undefined) delete process.env["JEV_INTENT_THRESHOLD"];
      else process.env["JEV_INTENT_THRESHOLD"] = originalThreshold;
    }
  });
});
