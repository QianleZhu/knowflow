import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AliyunLlmService } from "../../../shared/llm/aliyun-llm.js";
import {
  QueryUnderstandingService,
  matchIntentRule,
  type QueryUnderstandingInput,
} from "./query-understanding.service.js";

// 替身只验证规则、授权边界及故障处理；真实模型结果独立评测。
class RoutingLlmStub extends AliyunLlmService {
  llmCalls = 0;
  response = JSON.stringify({
    needsRetrieval: true,
    standaloneQuery: "出差报销需要哪些材料？",
    keywords: ["出差", "报销", "材料"],
    requestedKnowledgeBaseIds: [],
  });
  messages: Parameters<AliyunLlmService["completeChat"]>[0]["messages"] = [];

  // 意图识别禁止调用 embedding；误接入会立即让测试失败。
  override embedTexts(): Promise<number[][]> {
    return Promise.reject(new Error("Intent recognition must not call embeddings"));
  }

  // 捕获模型输入，验证规则未命中后只调用一次 LLM 并提供历史。
  override completeChat(input: Parameters<AliyunLlmService["completeChat"]>[0]): Promise<string> {
    this.llmCalls += 1;
    this.messages = input.messages;
    return Promise.resolve(this.response);
  }
}

// 构造授权范围与业务历史，检查混合意图和显式选库。
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

void describe("rule-first query understanding", () => {
  void it("directly handles pure greetings, thanks and metadata without a model", async () => {
    const llm = new RoutingLlmStub();
    const service = new QueryUnderstandingService(llm);
    for (const [text, route] of [
      ["你好！", "social"],
      ["晚上好，朋友", "social"],
      ["谢谢，问题搞定啦", "social"],
      ["你能做什么？", "capability"],
      ["我可以访问哪些知识库？", "scope"],
      ["哪些知识库已经向我的账号开放了？", "scope"],
      ["列出文档目录", "catalog"],
      ["陪我聊聊天", "redirect"],
    ]) {
      const plan = await service.understand(input(text));
      assert.equal(plan.route, route, text);
      assert.equal(plan.trace.source, "rule");
      assert.ok(plan.trace.ruleId);
    }
    assert.equal(llm.llmCalls, 0);
  });

  void it("never consumes business text following a greeting or metadata question", async () => {
    const llm = new RoutingLlmStub();
    const service = new QueryUnderstandingService(llm);
    for (const text of [
      "你好，那需要什么材料？",
      "谢谢，另外我想了解离职交接的规定",
      "我可以访问哪些知识库？另外报销需要什么材料？",
      "列出文档目录并解释报销流程",
      "给我讲个笑话，然后告诉我采购审批流程",
    ]) {
      assert.equal(matchIntentRule(input(text)), null);
      const plan = await service.understand(input(text));
      assert.equal(plan.trace.source, "llm");
      assert.equal(plan.trace.reason, "no_rule_match");
    }
    assert.equal(llm.llmCalls, 5);
    assert.ok(llm.messages.at(-1)?.content.includes("出差回来怎么报销"));
  });

  void it("lets unmatched expressions and contextual follow-ups go directly to the LLM", async () => {
    const llm = new RoutingLlmStub();
    const plan = await new QueryUnderstandingService(llm).understand(input());
    assert.equal(plan.route, "retrieve");
    assert.equal(plan.needsRetrieval, true);
    assert.equal(plan.answer, null);
    assert.equal(plan.standaloneQuery, "出差报销需要哪些材料？");
    assert.equal(llm.llmCalls, 1);
    assert.equal(plan.trace.ruleId, null);
  });

  void it("maps named catalog rules only to an unambiguous authorized library", async () => {
    const llm = new RoutingLlmStub();
    const service = new QueryUnderstandingService(llm);
    const plan = await service.understand(input("请列出人事知识库的文档名称，不需要正文"));
    assert.equal(plan.route, "catalog");
    assert.deepEqual(plan.requestedKnowledgeBaseIds, ["hr"]);
    assert.equal(plan.trace.ruleId, "catalog-named");
    assert.equal(llm.llmCalls, 0);
    assert.equal(matchIntentRule(input("列出秘密知识库的文档目录")), null);
    assert.equal(
      matchIntentRule({
        ...input("列出人事知识库的文档目录"),
        accessibleKnowledgeBases: [
          ...input().accessibleKnowledgeBases,
          { id: "other", name: "人事知识库", description: null },
        ],
      }),
      null,
    );
  });

  void it("rejects model-selected unauthorized IDs instead of falling back to all libraries", async () => {
    const llm = new RoutingLlmStub();
    llm.response = JSON.stringify({
      needsRetrieval: true,
      standaloneQuery: "工资标准",
      keywords: [],
      requestedKnowledgeBaseIds: ["secret"],
    });
    const plan = await new QueryUnderstandingService(llm).understand(input());
    assert.equal(plan.route, "direct");
    assert.equal(plan.needsRetrieval, false);
    assert.deepEqual(plan.requestedKnowledgeBaseIds, []);
  });

  void it("does not allow the LLM to infer a library from the business topic", async () => {
    const llm = new RoutingLlmStub();
    llm.response = JSON.stringify({
      needsRetrieval: true,
      standaloneQuery: "报销材料",
      keywords: [],
      requestedKnowledgeBaseIds: ["hr"],
    });
    const plan = await new QueryUnderstandingService(llm).understand(input("报销需要哪些材料"));
    assert.deepEqual(plan.requestedKnowledgeBaseIds, []);
  });

  void it("sends transform requests to the fixed direct reply without retrieval", async () => {
    const llm = new RoutingLlmStub();
    llm.response = JSON.stringify({
      needsRetrieval: false,
      standaloneQuery: "整理成表格",
      keywords: [],
      requestedKnowledgeBaseIds: [],
    });
    const plan = await new QueryUnderstandingService(llm).understand({
      ...input("整理成表格"),
      recentMessages: [],
    });
    assert.equal(plan.route, "direct");
    assert.equal(plan.needsRetrieval, false);
  });

  void it("preserves original queries on model failure and clarifies ambiguous follow-ups", async () => {
    const llm = new RoutingLlmStub();
    llm.response = "invalid JSON";
    const service = new QueryUnderstandingService(llm);
    const plan = await service.understand(input("报销需要哪些材料"));
    assert.equal(plan.trace.source, "degraded");
    assert.equal(plan.standaloneQuery, "报销需要哪些材料");
    assert.equal(plan.route, "retrieve");
    const ambiguous = await service.understand(input("这种申请需要谁审批？"));
    assert.equal(ambiguous.route, "direct");
    assert.ok(ambiguous.answer);
  });

  void it("can bypass rules for diagnostics without invoking embeddings", async () => {
    const llm = new RoutingLlmStub();
    const plan = await new QueryUnderstandingService(llm).understand(input("你好"), {
      mode: "llm_only",
    });
    assert.equal(plan.trace.source, "llm");
    assert.equal(llm.llmCalls, 1);
  });
  void it("routes summary requests to the fixed direct reply without generating text", async () => {
    const llm = new RoutingLlmStub();
    llm.response = JSON.stringify({
      needsRetrieval: false,
      standaloneQuery: "总结上一条回答",
      keywords: [],
      requestedKnowledgeBaseIds: [],
    });
    const plan = await new QueryUnderstandingService(llm).understand(input("总结上一条回答"));
    assert.equal(plan.route, "direct");
    assert.equal(plan.needsRetrieval, false);
    assert.equal(plan.answer, null);
    assert.equal(llm.llmCalls, 1);
    assert.equal(plan.trace.llmNeedsRetrieval, false);
  });

  void it("rejects inconsistent decisions and the old multi-category contract", async () => {
    const llm = new RoutingLlmStub();
    const service = new QueryUnderstandingService(llm);
    for (const response of [
      {
        needsRetrieval: false,
        answer: null,
        standaloneQuery: "报销材料",
        keywords: [],
        requestedKnowledgeBaseIds: [],
      },
      {
        needsRetrieval: true,
        answer: "凭记忆回答",
        standaloneQuery: "报销材料",
        keywords: [],
        requestedKnowledgeBaseIds: [],
      },
      {
        route: "social",
        standaloneQuery: "报销材料",
        keywords: [],
        requestedKnowledgeBaseIds: [],
        clarification: null,
      },
    ]) {
      llm.response = JSON.stringify(response);
      const plan = await service.understand(input("报销需要哪些材料"));
      assert.equal(plan.trace.source, "degraded");
      assert.equal(plan.needsRetrieval, true);
      assert.equal(plan.answer, null);
    }
  });

  void it("passes the full recent answer beyond the old 1200-character cutoff", async () => {
    const llm = new RoutingLlmStub();
    const content = "正文".repeat(800) + "最后必须保留的要点";
    await new QueryUnderstandingService(llm).understand({
      ...input("总结上面的内容"),
      recentMessages: [{ role: "assistant", content }],
    });
    assert.ok(llm.messages.at(-1)?.content.includes("最后必须保留的要点"));
  });
});
