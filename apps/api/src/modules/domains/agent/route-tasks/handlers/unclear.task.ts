// 本文件维护不明确请求的回答策略：先用原句检索，缺少证据时再澄清。
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 不明确意图保留原句检索策略；没有足够证据时由最终回答请求用户澄清。
export function createUnclearTaskResult(task: RouteTask): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "generation",
    status: "completed",
    content:
      "先检查本轮授权检索结果；有可靠依据时回答，无可靠依据时简短询问用户希望查询或处理什么。",
  });
}
