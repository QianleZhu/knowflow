// 本文件维护助手能力意图的固定回复，不依赖模型自行描述产品功能。
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

// 能力说明由服务端固定生成，避免将产品功能描述交给分类模型猜测。
export function executeAssistantCapabilityTask(task: RouteTask): RouteTaskResult {
  return createRouteTaskResult(task, {
    mode: "deterministic",
    status: "completed",
    content:
      "我可以查询你有权限访问的知识库，回答资料中的问题，展示可用知识库或资料目录，并整理上一条回答。你可以问：报销需要哪些材料？",
  });
}
