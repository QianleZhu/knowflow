// 本文件定义多意图任务和结果的共享契约，供 Agent 图与意图处理器复用。
import type { QueryIntent } from "../jev-intent.service.js";

// 路由任务把一次用户请求拆成可以独立执行、追踪和汇总的原子意图。
export type RouteTask = {
  id: string;
  intent: QueryIntent;
  query: string;
};

// 每个任务只返回后续汇总所需的数据，不直接向用户发送片段答案。
export type RouteTaskResult = {
  taskId: string;
  intent: QueryIntent;
  query: string;
  mode: "deterministic" | "generation";
  status: "completed" | "failed";
  content: string;
};

// 记录任务查询来自原请求、拆解模型还是模型失败后的安全回退。
export type RouteTaskPlanSource = "single_intent" | "planner" | "fallback";

// 为任务构造带有原始身份信息的结构化结果。
export function createRouteTaskResult(
  task: RouteTask,
  input: Pick<RouteTaskResult, "mode" | "status" | "content">,
): RouteTaskResult {
  return {
    taskId: task.id,
    intent: task.intent,
    query: task.query,
    ...input,
  };
}
