// 本文件集中分发意图操作并统一判断汇总方式，各业务处理器保持分文件维护。
import type { AccessibleKnowledgeBase } from "../agent-scope.js";
import { QUERY_INTENTS } from "../jev-intent.service.js";
import { executeAccessScopeTask } from "./handlers/access-scope.task.js";
import { executeAssistantCapabilityTask } from "./handlers/assistant-capability.task.js";
import { createConversationTransformTaskResult } from "./handlers/conversation-transform.task.js";
import { executeDocumentCatalogTask } from "./handlers/document-catalog.task.js";
import { createGeneralGenerationTaskResult } from "./handlers/general-generation.task.js";
import { createKnowledgeQaTaskResult } from "./handlers/knowledge-qa.task.js";
import { createUnclearTaskResult } from "./handlers/unclear.task.js";
import type { RouteTask, RouteTaskResult } from "./route-task.types.js";

export type RouteTaskExecutionContext = {
  originalQuery: string;
  knowledgeScope: string[];
  accessibleKnowledgeBases: AccessibleKnowledgeBase[];
  requestedKnowledgeBaseIds: string[];
};

// 将任务分发到按意图独立维护的操作文件；知识问答随后复用 Agent 的 RAG 图节点。
export async function executeRouteTask(
  task: RouteTask,
  context: RouteTaskExecutionContext,
): Promise<RouteTaskResult> {
  switch (task.intent) {
    case "knowledge_qa":
      return createKnowledgeQaTaskResult(task);
    case "document_catalog":
      return executeDocumentCatalogTask({
        task,
        originalQuery: context.originalQuery,
        knowledgeScope: context.knowledgeScope,
        accessibleKnowledgeBases: context.accessibleKnowledgeBases,
        requestedKnowledgeBaseIds: context.requestedKnowledgeBaseIds,
      });
    case "access_scope":
      return executeAccessScopeTask(task, context.accessibleKnowledgeBases);
    case "assistant_capability":
      return executeAssistantCapabilityTask(task);
    case "conversation_transform":
      return createConversationTransformTaskResult(task);
    case "general_generation":
      return createGeneralGenerationTaskResult(task);
    case "unclear":
      return createUnclearTaskResult(task);
    default: {
      const exhaustiveCheck: never = task.intent;
      return exhaustiveCheck;
    }
  }
}

// 判断一组任务是否需要最终模型生成或改写本轮回答。
export function requiresRouteTaskGeneration(results: RouteTaskResult[]): boolean {
  return results.some((result) => result.mode === "generation");
}

// 为无生成任务的路由结果构造一条完整回复，保持现有单一 SSE 输出通道。
export function aggregateDeterministicRouteResults(results: RouteTaskResult[]): string {
  return results
    .map((result, index) => {
      const title = getIntentLabel(result.intent);
      const content =
        result.status === "failed" ? "该项操作暂时无法完成，请稍后重试。" : result.content;
      return results.length === 1 ? content : `${String(index + 1)}. ${title}\n${content}`;
    })
    .join("\n\n");
}

// 为 Trace 与回复汇总使用稳定的中文任务名称。
export function getIntentLabel(intent: RouteTask["intent"]): string {
  const labels: Record<(typeof QUERY_INTENTS)[number], string> = {
    knowledge_qa: "知识问答",
    document_catalog: "文档目录",
    access_scope: "可访问范围",
    assistant_capability: "助手能力",
    conversation_transform: "对话整理",
    general_generation: "通用生成",
    unclear: "待澄清请求",
  };
  return labels[intent];
}
