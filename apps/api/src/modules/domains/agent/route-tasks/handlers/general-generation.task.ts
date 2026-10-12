// 本文件将通用创作意图转换成最终模型任务，不直接复用 Jev 分类输出作答。
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 通用创作任务交给最终回答模型执行，避免把分类器返回值误当成用户答案。
export function createGeneralGenerationTaskResult(task: RouteTask): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "generation",
    status: "completed",
    content: `请完成以下不依赖企业知识库事实的通用请求：${task.query}`,
  });
}
