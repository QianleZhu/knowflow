import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { agentRuns, agentRuntimeTraces, conversationMessages, db, users } from "@knowflow/db";
import {
  agentRunSnapshotSchema,
  askStreamEventSchema,
  type AgentRunErrorCode,
  type AgentRunEventEnvelope,
  type AgentRunSnapshot,
  type AgentRunStatus,
  type AskStreamEvent,
  type ConversationMessage,
} from "@knowflow/shared";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import Redis from "ioredis";

import type { AuthenticatedUser } from "../auth/auth.types.js";
import { AgentService } from "./agent.service.js";
import {
  buildAgentRunJobId,
  buildAgentRunJobOptions,
  createAgentRunQueue,
} from "./agent-run-queue.js";
import { buildAgentRunReplay } from "./agent-run-protocol.js";

const AGENT_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AGENT_RUN_STREAM_TTL_SECONDS = 24 * 60 * 60;
const AGENT_RUN_STREAM_MAX_LENGTH = 10_000;
const AGENT_RUN_STREAM_PREFIX = "agent:run:events";
const AGENT_RUN_SEQUENCE_INDEX_SUFFIX = "sequence-index";
const APPEND_RUN_EVENT_SCRIPT = `
local streamId = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'sequence', ARGV[2], 'event', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], streamId)
local oldest = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', 1)
if #oldest > 0 then
  local fields = oldest[1][2]
  for index = 1, #fields, 2 do
    if fields[index] == 'sequence' then
      redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', tonumber(fields[index + 1]) - 1)
      break
    end
  end
end
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return streamId
`;
const REBUILD_RUN_EVENT_INDEX_SCRIPT = `
redis.call('DEL', KEYS[2])
local rows = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', ARGV[1])
for _, row in ipairs(rows) do
  local fields = row[2]
  for index = 1, #fields, 2 do
    if fields[index] == 'sequence' then
      redis.call('ZADD', KEYS[2], fields[index + 1], row[1])
      break
    end
  end
end
if #rows > 0 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
return #rows
`;

type AgentRunRow = typeof agentRuns.$inferSelect;
type RunEvent = { runId: string; sequence: number; event: AskStreamEvent };
type PersistedRunEventEnvelope = Extract<AgentRunEventEnvelope, { type: "event" }>;
type RunEventBatch = {
  snapshotRequired: boolean;
  waitingForCheckpoint: boolean;
  minSequence: number;
  lastStreamId: string | null;
  events: PersistedRunEventEnvelope[];
  status: AgentRunStatus;
  lastSequence: number;
};
type AgentRunEventWaiter = {
  wait: (lastStreamId: string | null, timeoutMs: number) => Promise<void>;
  close: () => void;
};
type EventEmitter = {
  emit: (event: AskStreamEvent) => Promise<void>;
  flush: () => Promise<void>;
  hasFailure: () => boolean;
  hasCancellation: () => boolean;
  getError: () => unknown;
};

// 将用户问题的幂等创建、独立 Worker 执行、Redis 事件回放和 PostgreSQL 快照统一管理。
@Injectable()
export class AgentRunService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentRunService.name);
  private readonly redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    lazyConnect: true,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 5_000,
  });

  constructor(private readonly agentService: AgentService) {
    // Redis 事件缓存故障时，保留数据库快照并让订阅端自动回到快照恢复。
    this.redis.on("error", (error: Error) => {
      this.logger.warn(`Agent 事件缓存暂不可用：${error.message}`);
    });
  }

  // 释放应用级 Redis 连接，避免 API 与 Worker 关闭时遗留句柄。
  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  // 创建或取回相同 clientRequestId 对应的唯一运行，不在网络重试时重复插入用户消息。
  async startRun(input: {
    conversationId: string;
    content: string;
    clientRequestId: string;
    user: AuthenticatedUser;
  }): Promise<AgentRunSnapshot> {
    const requestHash = this.hashRequest(input.conversationId, input.content);
    const existing = await this.findByRequestId(input.clientRequestId, input.user.id);
    if (existing !== undefined) {
      this.assertSameRequest(existing, requestHash);
      this.assertNotExpired(existing);
      await this.ensureQueuedRunScheduled(existing);
      return this.getRun(existing.id, input.user);
    }

    await this.agentService.authorizeAsk(input.conversationId, input.user);
    const runId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + AGENT_RUN_TTL_MS);
    let created: AgentRunRow;
    try {
      created = await db.transaction(async (tx) => {
        // 用户问题与运行记录在同一事务中创建，避免出现没有运行归属的孤立消息。
        const [message] = await tx
          .insert(conversationMessages)
          .values({ conversationId: input.conversationId, role: "user", content: input.content })
          .returning({ id: conversationMessages.id });
        if (message === undefined) throw new Error("创建用户消息失败");
        const [run] = await tx
          .insert(agentRuns)
          .values({
            id: runId,
            userId: input.user.id,
            conversationId: input.conversationId,
            userMessageId: message.id,
            clientRequestId: input.clientRequestId,
            requestHash,
            status: "queued",
            expiresAt,
          })
          .returning();
        if (run === undefined) throw new Error("创建 Agent 运行记录失败");
        return run;
      });
    } catch (error) {
      // 并发重试可能同时通过首次查询；唯一约束胜出后仍返回同一个运行。
      const raced = await this.findByRequestId(input.clientRequestId, input.user.id);
      if (raced === undefined) throw error;
      this.assertSameRequest(raced, requestHash);
      this.assertNotExpired(raced);
      await this.ensureQueuedRunScheduled(raced);
      return this.getRun(raced.id, input.user);
    }

    try {
      const queue = createAgentRunQueue();
      try {
        await queue.add("execute", { runId }, buildAgentRunJobOptions(runId));
      } finally {
        await queue.close();
      }
    } catch (error) {
      // 入队失败写成可读取的失败运行，避免前端把已落库的问题误报成未发送。
      const message = "Agent 任务暂时无法排队，请稍后重新提问。";
      await this.appendRunEvent(runId, {
        type: "agent.failed",
        code: "service_unavailable",
        message,
      });
      await this.finalizeRun(runId, "failed", "service_unavailable", message);
      this.logger.error(`Agent run ${runId} 入队失败`, error);
    }

    return this.getRun(created.id, input.user);
  }

  // 按会话列出近期运行，供刷新页面时恢复处理中、失败或取消的部分答案。
  async listConversationRuns(
    conversationId: string,
    user: AuthenticatedUser,
  ): Promise<{ items: AgentRunSnapshot[] }> {
    const rows = await db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          eq(agentRuns.userId, user.id),
          gt(agentRuns.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(20);
    // 会话刷新也修复 API 在写入运行后、首次入队前退出造成的排队孤儿。
    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.ensureQueuedRunScheduled(row);
        } catch (error) {
          this.logger.warn(`Agent run ${row.id} 重新入队失败：${String(error)}`);
        }
      }),
    );
    // 在运行行读取后再加载消息，消除生成刚完成时“run 已终态但消息列表仍旧”的竞态。
    const messages = await this.agentService.listMessages(conversationId, user);
    const messageById = new Map(messages.items.map((message) => [message.id, message]));
    return {
      items: await Promise.all(
        rows.map((row) =>
          this.toSnapshot(row, messageById.get(row.assistantMessageId ?? "") ?? null),
        ),
      ),
    };
  }

  // 读取指定运行并检查用户归属；过期运行以 410 明确通知客户端回到历史快照。
  async getRun(runId: string, user: AuthenticatedUser): Promise<AgentRunSnapshot> {
    const row = await this.findOwnedRun(runId, user.id);
    this.assertNotExpired(row);
    let assistantMessage: ConversationMessage | null = null;
    if (row.assistantMessageId !== null) {
      const messages = await this.agentService.listMessages(row.conversationId, user);
      assistantMessage =
        messages.items.find((message) => message.id === row.assistantMessageId) ?? null;
    }
    return this.toSnapshot(row, assistantMessage);
  }

  // 通过幂等键找回 POST 响应丢失时已创建的运行，不会再次提交生成任务。
  async getRunByRequestId(
    clientRequestId: string,
    user: AuthenticatedUser,
  ): Promise<AgentRunSnapshot> {
    const row = await this.findByRequestId(clientRequestId, user.id);
    if (row === undefined) throw new NotFoundException("未找到对应运行");
    this.assertNotExpired(row);
    await this.ensureQueuedRunScheduled(row);
    return this.getRun(row.id, user);
  }

  // 只写入取消请求，交由 Worker 中止模型调用并保留取消 Trace。
  async cancelRun(runId: string, user: AuthenticatedUser): Promise<AgentRunSnapshot> {
    const row = await this.findOwnedRun(runId, user.id);
    this.assertNotExpired(row);
    if (row.status === "queued" || row.status === "running") {
      await db
        .update(agentRuns)
        .set({ status: "cancel_requested", updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ["queued", "running"])));
    }
    return this.getRun(runId, user);
  }

  // 从 Redis Stream 按序号回放事件；缺失或过期的事件要求客户端读取数据库快照。
  async readRunEvents(
    runId: string,
    afterSequence: number,
    user: AuthenticatedUser,
  ): Promise<RunEventBatch> {
    const run = await this.findOwnedRun(runId, user.id);
    this.assertNotExpired(run);
    const key = this.streamKey(runId);
    let parsedEvents: RunEvent[] = [];
    let lastStreamId: string | null = null;
    try {
      await this.ensureRunEventIndex(runId);
      const indexKey = this.sequenceIndexKey(runId);
      const [lastRow, streamIds] = await Promise.all([
        this.redis.xrevrange(key, "+", "-", "COUNT", 1),
        this.redis.zrangebyscore(indexKey, `(${String(afterSequence)}`, "+inf", "LIMIT", 0, 101),
      ]);
      lastStreamId = lastRow[0]?.[0] ?? null;
      if (streamIds.length > 0) {
        const orderedIds = [...streamIds].sort((left, right) =>
          this.compareRedisStreamIds(left, right),
        );
        const firstId = orderedIds[0];
        const lastId = orderedIds.at(-1);
        if (firstId !== undefined && lastId !== undefined) {
          const rows = await this.redis.xrange(key, firstId, lastId, "COUNT", 101);
          parsedEvents = this.parseRunEvents(runId, rows);
        }
      }
    } catch {
      // Redis 不可用时由后续快照 GET 恢复完整答案和当前终态。
      parsedEvents = [];
      lastStreamId = null;
    }

    const replay = buildAgentRunReplay(
      parsedEvents,
      afterSequence,
      run.checkpointSequence,
      run.lastSequence,
    );
    const events = replay.events.map((item) => ({
      type: "event" as const,
      runId,
      sequence: item.sequence,
      event: item.event,
    })) satisfies PersistedRunEventEnvelope[];
    return {
      snapshotRequired: replay.snapshotRequired,
      waitingForCheckpoint: replay.waitingForCheckpoint,
      minSequence: replay.minSequence,
      lastStreamId,
      events,
      status: run.status as AgentRunStatus,
      lastSequence: run.lastSequence,
    };
  }

  // 为单条 SSE 连接创建阻塞读取器，避免共享 Redis 连接被 XREAD BLOCK 占用。
  createRunEventWaiter(runId: string): AgentRunEventWaiter {
    const blockingRedis = this.redis.duplicate({ commandTimeout: 20_000 });
    const key = this.streamKey(runId);
    // Redis 暂时不可用时由 SSE 轮询快照兜底，避免阻塞连接的错误成为未处理异常。
    blockingRedis.on("error", (error: Error) => {
      this.logger.warn(`Agent run ${runId} 阻塞订阅连接异常：${error.message}`);
    });
    return {
      wait: async (lastStreamId, timeoutMs) => {
        await blockingRedis.xread(
          "COUNT",
          1,
          "BLOCK",
          timeoutMs,
          "STREAMS",
          key,
          lastStreamId ?? "0-0",
        );
      },
      close: () => blockingRedis.disconnect(),
    };
  }

  // Worker 按数据库记录重新读取账号与用户问题，避免信任队列内携带的权限快照。
  async processRun(runId: string): Promise<{ status: "completed" | "skipped" }> {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    if (run === undefined || this.isTerminal(run.status)) return { status: "skipped" };
    if (run.status === "running") {
      if (await this.recoverCompletedRun(run)) return { status: "skipped" };
      await this.recoverUncheckpointedAnswer(run);
      await this.failRun(
        runId,
        "worker_interrupted",
        "运行 Worker 中断，已保留当前部分答案。",
        true,
      );
      return { status: "skipped" };
    }

    const cancellation = new AbortController();
    if (run.status === "cancel_requested") cancellation.abort();
    else {
      await db
        .update(agentRuns)
        .set({ status: "running", updatedAt: new Date() })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")));
    }
    const emitter = this.createBufferedEmitter(runId);
    const cancellationPoll = setInterval(() => {
      void this.checkCancellation(runId, cancellation);
    }, 500);
    try {
      const [account] = await db
        .select({
          id: users.id,
          username: users.username,
          name: users.name,
          platformRole: users.platformRole,
          departmentId: users.departmentId,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, run.userId))
        .limit(1);
      if (account?.status !== "active") {
        throw new ForbiddenException("账号已停用，无法继续此运行。");
      }
      const [userMessage] = await db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.id, run.userMessageId),
            eq(conversationMessages.conversationId, run.conversationId),
          ),
        )
        .limit(1);
      if (userMessage === undefined) throw new NotFoundException("运行关联的问题已不存在。");

      await this.agentService.ask({
        conversationId: run.conversationId,
        content: userMessage.content,
        user: {
          id: account.id,
          username: account.username,
          name: account.name,
          platformRole: account.platformRole,
          departmentId: account.departmentId,
        },
        userMessageId: run.userMessageId,
        signal: cancellation.signal,
        emit: emitter.emit,
      });
      await emitter.flush();
      await this.finalizeRun(runId, "completed", null, null);
      return { status: "completed" };
    } catch (error) {
      await emitter.flush().catch((flushError: unknown) => {
        this.logger.error(`Agent run ${runId} 的最后一批事件未能落库`, flushError);
      });
      if (cancellation.signal.aborted && emitter.getError() === null) {
        if (!emitter.hasCancellation()) {
          await emitter.emit({
            type: "agent.cancelled",
            message: "已停止生成，已保留已输出内容。",
          });
        }
        await emitter.flush();
        await this.finalizeRun(runId, "cancelled", "cancelled", "已停止生成，已保留已输出内容。");
      } else {
        const code =
          emitter.getError() === null ? this.classifyRunFailure(error) : "service_unavailable";
        const message = error instanceof Error ? error.message : "Agent 生成失败。";
        if (!emitter.hasFailure()) await emitter.emit({ type: "agent.failed", code, message });
        await emitter.flush();
        await this.finalizeRun(runId, "failed", code, message);
      }
      return { status: "completed" };
    } finally {
      clearInterval(cancellationPoll);
      await emitter.flush().catch((flushError: unknown) => {
        this.logger.error(`Agent run ${runId} Worker 退出时无法 flush delta`, flushError);
      });
    }
  }

  // 定期删除过期运行与对应 Redis 事件流，避免历史恢复数据无限增长。
  async pruneExpiredRuns(): Promise<number> {
    const deleted = await db
      .delete(agentRuns)
      .where(lt(agentRuns.expiresAt, new Date()))
      .returning({ id: agentRuns.id });
    if (deleted.length > 0) {
      const keys = deleted.flatMap(({ id }) => [this.streamKey(id), this.sequenceIndexKey(id)]);
      await this.redis.del(...keys).catch(() => 0);
    }
    return deleted.length;
  }

  // 幂等键摘要包含会话和问题正文，避免同一键意外复用到另一条请求。
  private hashRequest(conversationId: string, content: string): string {
    return createHash("sha256").update(`${conversationId}\0${content}`).digest("hex");
  }

  // 拒绝将已有幂等键用于不同的会话或问题。
  private assertSameRequest(run: AgentRunRow, requestHash: string): void {
    if (run.requestHash !== requestHash) {
      throw new ConflictException(
        "clientRequestId 已被另一条问题占用，请为新问题生成新的请求 ID。",
      );
    }
  }

  // 查询当前用户创建的幂等运行。
  private async findByRequestId(
    clientRequestId: string,
    userId: string,
  ): Promise<AgentRunRow | undefined> {
    const [row] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.clientRequestId, clientRequestId), eq(agentRuns.userId, userId)))
      .limit(1);
    return row;
  }

  // 从重连读取路径补投孤立的 queued 任务，并安全重试队列中已失败的占位 Job。
  private async ensureQueuedRunScheduled(run: AgentRunRow): Promise<void> {
    if (run.status !== "queued") return;
    const queue = createAgentRunQueue();
    try {
      const jobId = buildAgentRunJobId(run.id);
      const existingJob = await queue.getJob(jobId);
      if (existingJob !== undefined) {
        const state = await existingJob.getState();
        if (state !== "failed" && state !== "completed") return;
        await existingJob.remove();
      }
      await queue.add("execute", { runId: run.id }, buildAgentRunJobOptions(run.id));
    } finally {
      await queue.close();
    }
  }

  // 通过所有者条件查找运行，未授权与不存在统一返回 404 防止枚举他人运行 ID。
  private async findOwnedRun(runId: string, userId: string): Promise<AgentRunRow> {
    const [row] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);
    if (row === undefined) throw new NotFoundException("未找到运行");
    return row;
  }

  // 拒绝恢复已过期运行；客户端应重新读取普通会话消息历史。
  private assertNotExpired(run: AgentRunRow): void {
    if (run.expiresAt.getTime() <= Date.now())
      throw new GoneException("运行快照已过期，请重新加载会话历史。");
  }

  // 将数据库和 Redis 中的当前运行信息转换为共享响应契约。
  private async toSnapshot(
    run: AgentRunRow,
    assistantMessage: ConversationMessage | null = null,
  ): Promise<AgentRunSnapshot> {
    const minSequence = await this.getMinSequence(run.id, run.lastSequence);
    return agentRunSnapshotSchema.parse({
      id: run.id,
      conversationId: run.conversationId,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      clientRequestId: run.clientRequestId,
      status: run.status,
      lastSequence: run.lastSequence,
      checkpointSequence: run.checkpointSequence,
      minSequence,
      answer: run.answerSnapshot,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      assistantMessage,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      expiresAt: run.expiresAt.toISOString(),
    });
  }

  // 读取 Stream 中首个序号，判断客户端游标之前是否已被裁剪。
  private async getMinSequence(runId: string, lastSequence: number): Promise<number> {
    try {
      await this.ensureRunEventIndex(runId);
      const first = await this.redis.zrange(this.sequenceIndexKey(runId), 0, 0, "WITHSCORES");
      const sequence = Number(first[1]);
      return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : lastSequence + 1;
    } catch {
      return lastSequence + 1;
    }
  }

  // 旧运行的 Stream 尚无序号索引时，用一次原子脚本重建，后续查询只读取游标之后的事件。
  private async ensureRunEventIndex(runId: string): Promise<void> {
    const indexKey = this.sequenceIndexKey(runId);
    if ((await this.redis.zcard(indexKey)) > 0) return;
    if ((await this.redis.xlen(this.streamKey(runId))) === 0) return;
    await this.redis.eval(
      REBUILD_RUN_EVENT_INDEX_SCRIPT,
      2,
      this.streamKey(runId),
      indexKey,
      String(AGENT_RUN_STREAM_MAX_LENGTH + 100),
      String(AGENT_RUN_STREAM_TTL_SECONDS),
    );
  }

  // 按 Redis Stream ID 的两个十进制部分排序，兼容并发事件到达顺序与数据库序号不同。
  private compareRedisStreamIds(left: string, right: string): number {
    const [leftMilliseconds = "0", leftOrdinal = "0"] = left.split("-");
    const [rightMilliseconds = "0", rightOrdinal = "0"] = right.split("-");
    const millisecondsDifference = BigInt(leftMilliseconds) - BigInt(rightMilliseconds);
    if (millisecondsDifference < 0n) return -1;
    if (millisecondsDifference > 0n) return 1;
    const ordinalDifference = BigInt(leftOrdinal) - BigInt(rightOrdinal);
    return ordinalDifference < 0n ? -1 : ordinalDifference > 0n ? 1 : 0;
  }

  // Worker 重投时检查 Trace 与回答是否已在崩溃前提交，避免把成功答案误标成中断。
  private async recoverCompletedRun(run: AgentRunRow): Promise<boolean> {
    let assistantMessageId = run.assistantMessageId;
    if (assistantMessageId === null) {
      const [trace] = await db
        .select({ messageId: agentRuntimeTraces.messageId })
        .from(agentRuntimeTraces)
        .where(
          and(
            eq(agentRuntimeTraces.userMessageId, run.userMessageId),
            eq(agentRuntimeTraces.status, "completed"),
          ),
        )
        .limit(1);
      assistantMessageId = trace?.messageId ?? null;
    }
    if (assistantMessageId === null) return false;
    const [message] = await db
      .select({ id: conversationMessages.id, content: conversationMessages.content })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, assistantMessageId),
          eq(conversationMessages.conversationId, run.conversationId),
          eq(conversationMessages.role, "assistant"),
        ),
      )
      .limit(1);
    if (message === undefined) return false;
    await db
      .update(agentRuns)
      .set({
        status: "completed",
        assistantMessageId: message.id,
        answerSnapshot: message.content,
        checkpointSequence: run.lastSequence,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));
    return true;
  }

  // Worker 意外退出时，从 Redis 补回尚未进入 PostgreSQL 快照的逐 delta 事件。
  private async recoverUncheckpointedAnswer(run: AgentRunRow): Promise<void> {
    let recoveredDelta = "";
    try {
      const rows = await this.redis.xrange(
        this.streamKey(run.id),
        "-",
        "+",
        "COUNT",
        AGENT_RUN_STREAM_MAX_LENGTH + 100,
      );
      recoveredDelta = this.parseRunEvents(run.id, rows)
        .filter(
          (
            item,
          ): item is RunEvent & {
            event: Extract<AskStreamEvent, { type: "agent.answer.delta" }>;
          } => item.sequence > run.checkpointSequence && item.event.type === "agent.answer.delta",
        )
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ event }) => event.delta)
        .join("");
    } catch (error) {
      this.logger.warn(`Agent run ${run.id} 无法从 Redis 恢复尾部 delta：${String(error)}`);
    }

    await db
      .update(agentRuns)
      .set({
        ...(recoveredDelta.length === 0
          ? {}
          : { answerSnapshot: sql`${agentRuns.answerSnapshot} || ${recoveredDelta}` }),
        checkpointSequence: run.lastSequence,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));
  }

  // 校验 Redis Stream 事件载荷并解出运行序号，损坏条目由快照缺口协议处理。
  private parseRunEvents(runId: string, rows: [string, string[]][]): RunEvent[] {
    return rows.flatMap(([id, fields]) => {
      const values = this.streamFields(fields);
      const sequence = Number(values.get("sequence"));
      const payload = values.get("event");
      if (!Number.isSafeInteger(sequence) || payload === undefined) return [];
      try {
        const event = askStreamEventSchema.parse(JSON.parse(payload));
        return [{ runId, sequence, event }];
      } catch {
        this.logger.warn(`Agent run ${runId} Redis 事件格式损坏 (${id})`);
        return [];
      }
    });
  }

  // 将 Redis Stream 的键值对序列化为易查找的字段映射。
  private streamFields(fields: string[]): Map<string, string> {
    const values = new Map<string, string>();
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const key = fields[index];
      const value = fields[index + 1];
      if (key !== undefined && value !== undefined) values.set(key, value);
    }
    return values;
  }

  // 每个 delta 立即写入事件流，只合并 PostgreSQL 正文快照以控制文本持久化频率。
  private createBufferedEmitter(runId: string): EventEmitter {
    let pendingDelta = "";
    let pendingSequence = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let flushPromise: Promise<void> | null = null;
    let failureSent = false;
    let cancellationSent = false;
    let persistenceError: Error | null = null;

    const flush = async (): Promise<void> => {
      if (persistenceError !== null) throw persistenceError;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (flushPromise !== null) {
        await flushPromise;
        if (pendingDelta.length > 0) await flush();
        return;
      }
      const delta = pendingDelta;
      const checkpointSequence = pendingSequence;
      if (delta.length === 0) return;
      pendingDelta = "";
      pendingSequence = 0;
      flushPromise = this.persistAnswerCheckpoint(runId, delta, checkpointSequence);
      try {
        await flushPromise;
      } catch (error) {
        persistenceError = error instanceof Error ? error : new Error(String(error));
        throw persistenceError;
      } finally {
        flushPromise = null;
      }
      if (pendingDelta.length > 0) await flush();
    };

    const emit = async (event: AskStreamEvent): Promise<void> => {
      if (event.type === "agent.answer.delta") {
        // 为原始 delta 单独分配序号并写 Redis；浏览器不再等待正文快照合并。
        const sequence = await this.appendRunEvent(runId, event);
        pendingDelta += event.delta;
        pendingSequence = sequence;
        if (pendingDelta.length >= 2048) {
          await flush();
        } else {
          flushTimer ??= setTimeout(() => {
            void flush().catch((error: unknown) => {
              persistenceError = error instanceof Error ? error : new Error(String(error));
              this.logger.error(`Agent run ${runId} delta 快照写入失败`, error);
            });
          }, 50);
        }
        return;
      }
      await flush();
      if (event.type === "agent.failed") failureSent = true;
      if (event.type === "agent.cancelled") cancellationSent = true;
      await this.appendRunEvent(runId, event);
    };

    return {
      emit,
      flush,
      hasFailure: () => failureSent,
      hasCancellation: () => cancellationSent,
      getError: () => persistenceError,
    };
  }

  // 为单个事件分配数据库序号并立即写入 Redis Stream，Redis 故障时由快照修复正文。
  private async appendRunEvent(runId: string, event: AskStreamEvent): Promise<number> {
    const updates: Record<string, unknown> = {
      lastSequence: sql`${agentRuns.lastSequence} + 1`,
      updatedAt: new Date(),
    };
    // 非 delta 事件之前会强制 flush，因此该事件序号也已包含在正文快照中。
    if (event.type !== "agent.answer.delta") {
      updates["checkpointSequence"] = sql`${agentRuns.lastSequence} + 1`;
    }
    if (event.type === "agent.completed") {
      updates["assistantMessageId"] = event.message.id;
      // 终态消息是完整权威正文，可修复任何已在网络层丢失的中间 delta。
      updates["answerSnapshot"] = event.message.content;
    }
    const [run] = await db
      .update(agentRuns)
      .set(updates)
      .where(eq(agentRuns.id, runId))
      .returning({ sequence: agentRuns.lastSequence });
    if (run === undefined) throw new NotFoundException("运行已不存在");

    try {
      // Lua 原子追加 Stream 与序号索引，确保 SSE 唤醒和 afterSequence 回放指向同一条事件。
      await this.redis.eval(
        APPEND_RUN_EVENT_SCRIPT,
        2,
        this.streamKey(runId),
        this.sequenceIndexKey(runId),
        String(AGENT_RUN_STREAM_MAX_LENGTH),
        String(run.sequence),
        JSON.stringify(event),
        String(AGENT_RUN_STREAM_TTL_SECONDS),
      );
    } catch (error) {
      // 保留数据库序号；正文 checkpoint 追上后，订阅端通过快照修复 Redis 事件缺口。
      this.logger.warn(`Agent run ${runId} Redis 事件写入失败：${String(error)}`);
    }
    return run.sequence;
  }

  // 将一帧内合并的正文写入 PostgreSQL，并记录正文覆盖到的最后一个事件序号。
  private async persistAnswerCheckpoint(
    runId: string,
    delta: string,
    checkpointSequence: number,
  ): Promise<void> {
    const [run] = await db
      .update(agentRuns)
      .set({
        answerSnapshot: sql`${agentRuns.answerSnapshot} || ${delta}`,
        checkpointSequence: sql`GREATEST(${agentRuns.checkpointSequence}, ${checkpointSequence})`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId))
      .returning({ id: agentRuns.id });
    if (run === undefined) throw new NotFoundException("运行已不存在");
  }

  // 写入明确终态；仅 Worker 能决定生成完成、失败或取消已实际生效。
  private async finalizeRun(
    runId: string,
    status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled">,
    errorCode: AgentRunErrorCode | null,
    errorMessage: string | null,
  ): Promise<void> {
    await db
      .update(agentRuns)
      .set({ status, errorCode, errorMessage, updatedAt: new Date() })
      .where(
        and(
          eq(agentRuns.id, runId),
          inArray(agentRuns.status, ["queued", "running", "cancel_requested"]),
        ),
      );
  }

  // 输出终态失败事件并保留已缓存答案，供重新连接客户端显示和人工重试。
  private async failRun(
    runId: string,
    code: AgentRunErrorCode,
    message: string,
    emitEvent: boolean,
  ): Promise<void> {
    if (emitEvent) await this.appendRunEvent(runId, { type: "agent.failed", code, message });
    await this.finalizeRun(runId, "failed", code, message);
  }

  // 定期检查显式取消请求，使跨 API/Worker 实例的中断在半秒左右传到模型调用。
  private async checkCancellation(runId: string, controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    try {
      const [row] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (row?.status === "cancel_requested") controller.abort();
    } catch (error) {
      this.logger.warn(`Agent run ${runId} 取消状态轮询失败：${String(error)}`);
    }
  }

  // 将生成失败映射为稳定错误码，前端据此区分权限、限流、服务故障和模型失败。
  private classifyRunFailure(error: unknown): AgentRunErrorCode {
    if (error instanceof ForbiddenException) return "permission_denied";
    if (typeof error === "object" && error !== null && "getStatus" in error) {
      const status = (error as { getStatus?: () => number }).getStatus?.();
      if (status === 401) return "authentication_required";
      if (status === 403) return "permission_denied";
      if (status === 429) return "rate_limited";
      if (status !== undefined && status >= 500) return "service_unavailable";
    }
    return "generation_failed";
  }

  // 判断运行是否已到达不允许再次执行的最终状态。
  private isTerminal(status: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  // 为每个运行隔离 Redis Stream 键，避免不同会话的序号和载荷交叉。
  private streamKey(runId: string): string {
    return `${AGENT_RUN_STREAM_PREFIX}:${runId}`;
  }

  // 为运行事件序号索引生成独立 Redis 键，并与事件流使用相同过期范围。
  private sequenceIndexKey(runId: string): string {
    return `${this.streamKey(runId)}:${AGENT_RUN_SEQUENCE_INDEX_SUFFIX}`;
  }
}
