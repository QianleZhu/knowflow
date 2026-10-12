// 本文件将对话整理意图转换为最终模型可执行的受控任务上下文。
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 对话转换任务交给最终回答模型执行，并从已经加载的会话历史中取得处理素材。
export function createConversationTransformTaskResult(task: RouteTask): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "generation",
    status: "completed",
    content: `请对话中已有内容执行以下转换要求：${task.query}`,
  });
}
