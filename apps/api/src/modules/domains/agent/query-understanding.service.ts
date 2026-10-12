import { Inject, Injectable } from "@nestjs/common";

import {
  QUERY_INTENTS,
  type JevIntentClassification,
  type JevIntentRequest,
  type QueryIntent,
  JevIntentService,
} from "./jev-intent.service.js";
import {
  QUERY_ROUTER_VERSION,
  INTENT_RULES,
  NAMED_CATALOG_PATTERN,
  normalizeIntentText,
  type QueryRoute,
} from "./query-router.config.js";
import type { AccessibleKnowledgeBase } from "./agent-scope.js";

export type QueryUnderstandingInput = JevIntentRequest & {
  accessibleKnowledgeBases: AccessibleKnowledgeBase[];
};

// route 保留给诊断与兼容字段使用，实际操作由独立 RouteTask 处理器执行。
type PlanContent = {
  route: QueryRoute;
  intents: QueryIntent[];
  intentScores: Record<QueryIntent, number | null>;
  isMixed: boolean;
  needsRetrieval: boolean;
  answer: string | null;
  standaloneQuery: string;
  keywords: string[];
  requestedKnowledgeBaseIds: string[];
};

export type QueryPlan = PlanContent & {
  trace: {
    version: string;
    mode: "jev";
    source: "jev" | "degraded";
    ruleId: string | null;
    reason: string;
    classificationAttempts: number;
    model: string | null;
    threshold: number;
    latencyMs: number;
  };
};

// Jev 不可用时保留全量意图键，并用 null 明确区分“未知”与低置信度。
const NULL_INTENT_SCORES = Object.fromEntries(
  QUERY_INTENTS.map((intent) => [intent, null]),
) as Record<QueryIntent, number | null>;

@Injectable()
export class QueryUnderstandingService {
  constructor(@Inject(JevIntentService) private readonly jev: JevIntentService) {}

  // 用 Jev 多标签概率识别本轮请求，并在模型失败时保守退回知识检索。
  async understand(
    input: QueryUnderstandingInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<QueryPlan> {
    const started = Date.now();
    const threshold = getIntentThreshold();
    let classification: JevIntentClassification | null = null;
    try {
      classification = await this.jev.classify(input, options);
    } catch (error) {
      // 用户主动取消时保留取消语义，不把中断误当作模型降级。
      if (options.signal?.aborted) throw error;
    }

    const intentScores = classification?.probabilities ?? NULL_INTENT_SCORES;
    const positiveIntents = QUERY_INTENTS.filter(
      (intent) =>
        intent !== "unclear" && intentScores[intent] !== null && intentScores[intent] >= threshold,
    );
    const intents: QueryIntent[] = positiveIntents.length > 0 ? positiveIntents : ["unclear"];
    const isMixed = positiveIntents.length > 1;
    const rule = matchIntentRule(input);
    const needsRetrieval =
      classification === null || intents.includes("knowledge_qa") || intents.includes("unclear");
    const route = resolveLegacyRoute(intents, needsRetrieval, isMixed, rule?.route ?? null);
    const requestedKnowledgeBaseIds =
      route === "catalog" && rule?.route === "catalog" ? rule.knowledgeBaseIds : [];

    return {
      route,
      intents,
      intentScores,
      isMixed,
      needsRetrieval,
      answer: null,
      // 查询改写目前停用，保留旧快照字段并继续使用原始问题。
      standaloneQuery: input.query.trim(),
      keywords: [],
      requestedKnowledgeBaseIds,
      trace: {
        version: QUERY_ROUTER_VERSION,
        mode: "jev",
        source: classification === null ? "degraded" : "jev",
        ruleId: rule?.id ?? null,
        reason: classification === null ? "jev_unavailable_safe_retrieval" : "jev_multilabel",
        classificationAttempts: 1,
        model: classification?.model ?? null,
        threshold,
        latencyMs: Date.now() - started,
      },
    };
  }
}

// 将多意图结果投影到当前单路由图，避免本阶段提前引入各路由执行器。
function resolveLegacyRoute(
  intents: QueryIntent[],
  needsRetrieval: boolean,
  isMixed: boolean,
  ruleRoute: QueryRoute | null,
): QueryRoute {
  if (needsRetrieval) return "retrieve";
  if (isMixed || intents.length !== 1) return "direct";
  switch (intents[0]) {
    case "document_catalog":
      return "catalog";
    case "access_scope":
      return "scope";
    case "assistant_capability":
      return "capability";
    case "conversation_transform":
      return "direct";
    case "general_generation":
      return ruleRoute === "social" || ruleRoute === "redirect" ? ruleRoute : "direct";
    case "knowledge_qa":
    case "unclear":
      return "retrieve";
    default:
      return "retrieve";
  }
}

// 读取并校验多意图命中阈值，缺省值为 0.5。
function getIntentThreshold(): number {
  const configured = process.env["JEV_INTENT_THRESHOLD"]?.trim();
  if (!configured) return 0.5;
  const threshold = Number(configured);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("JEV_INTENT_THRESHOLD 必须是 0 到 1 之间的数字");
  }
  return threshold;
}

// 对严格整句规则做匹配，只用于维持单意图快捷路由和已授权目录范围映射。
export function matchIntentRule(
  input: QueryUnderstandingInput,
): { id: string; route: QueryRoute; knowledgeBaseIds: string[] } | null {
  const text = normalizeIntentText(input.query);
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) return { id: rule.id, route: rule.route, knowledgeBaseIds: [] };
  }
  const named = NAMED_CATALOG_PATTERN.exec(text);
  if (named?.[1]) {
    const matches = input.accessibleKnowledgeBases.filter((item) => {
      const name = normalizeIntentText(item.name);
      return named[1] === name || named[1] === name.replace(/(?:知识库|资料库|文档库)$/u, "库");
    });
    if (matches.length === 1) {
      return {
        id: "catalog-named",
        route: "catalog",
        knowledgeBaseIds: matches.map((item) => item.id),
      };
    }
  }
  return null;
}
