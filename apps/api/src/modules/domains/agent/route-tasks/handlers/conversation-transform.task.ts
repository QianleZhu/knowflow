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
    // 转换意图明确不代表原文齐全；要求最终模型检查素材，缺失时澄清而不是编造。
    content: `请对话中已有内容执行以下转换要求：${task.query}。先检查用户提供的文本和会话历史是否包含所需原文；若原文或所指的上一条回答缺失，请简短说明并请用户补充待处理内容，不要编造原文，也不要将检索到的其他资料当作原文。`,
  });
}
