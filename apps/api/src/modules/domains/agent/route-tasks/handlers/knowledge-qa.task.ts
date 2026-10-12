// 本文件承接知识问答任务的 RAG 上下文组织，实际检索继续复用 Agent 原有节点。
import type { RetrievalContextItem } from "../../../retrieval/retrieval.types.js";
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 知识问答任务沿用 Agent 现有的权限过滤检索链路，并要求最终模型基于授权资料回答。
export function createKnowledgeQaTaskResult(task: RouteTask): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "generation",
    status: "completed",
    content: `知识问答子任务：${task.query}`,
  });
}

// 将已选中的检索片段连同知识库、文档和位置元数据打包为最终模型参考资料。
export function buildKnowledgeReferenceContext(contexts: RetrievalContextItem[]): string {
  return contexts
    .map((item, index) => {
      const location = item.pageOrSection ?? "未标注";
      const headingPath = item.metadata?.headingPath?.filter((part) => part.length > 0).join(" > ");
      const heading =
        headingPath === undefined || headingPath.length === 0 ? "" : `\n标题路径：${headingPath}`;
      return [
        `[参考资料 ${String(index + 1)}]`,
        `知识库：${item.knowledgeBaseName}`,
        `文档：${item.title}`,
        `位置：${location}${heading}`,
        `资料 ID：${item.id}`,
        `正文：\n${item.contextText}`,
      ].join("\n");
    })
    .join("\n\n");
}
