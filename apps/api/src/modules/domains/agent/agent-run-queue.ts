import { Queue, type JobsOptions } from "bullmq";

import { getRedisConnectionOptions } from "../../../shared/redis/redis-connection.js";

export const AGENT_RUN_QUEUE_NAME = "agent-run";
export const AGENT_RUN_EXECUTE_JOB = "execute";
export const AGENT_RUN_CLEANUP_JOB = "cleanup";

export type AgentRunJob = { runId: string } | Record<string, never>;
export type AgentRunJobName = typeof AGENT_RUN_EXECUTE_JOB | typeof AGENT_RUN_CLEANUP_JOB;
export type AgentRunJobResult = { status: "completed" | "skipped"; runId?: string };

// 运行任务仅自动执行一次，Worker 崩溃后的重投由运行快照检测并转为明确失败。
export function buildAgentRunJobOptions(runId: string): JobsOptions {
  return {
    jobId: buildAgentRunJobId(runId),
    attempts: 1,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  };
}

// 为每个 run 生成稳定队列 ID，使重复补投只保留一份待执行任务。
export function buildAgentRunJobId(runId: string): string {
  return `agent-run-${runId}`;
}

// 创建 API 与 Worker 共用的 Agent 运行队列。
export function createAgentRunQueue(): Queue<AgentRunJob, AgentRunJobResult, AgentRunJobName> {
  return new Queue<AgentRunJob, AgentRunJobResult, AgentRunJobName>(AGENT_RUN_QUEUE_NAME, {
    connection: getRedisConnectionOptions(),
  });
}
