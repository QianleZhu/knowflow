// 本文件将服务端已授权的知识库列表转换为确定性的访问范围结果。
import { buildKnowledgeScopeAnswer, type AccessibleKnowledgeBase } from "../../agent-scope.js";
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 访问范围回答只使用服务端已解析的可访问知识库，不接受分类模型提供的范围。
export function executeAccessScopeTask(
  task: RouteTask,
  accessibleKnowledgeBases: AccessibleKnowledgeBase[],
): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "deterministic",
    status: "completed",
    content: buildKnowledgeScopeAnswer(accessibleKnowledgeBases),
  });
}
