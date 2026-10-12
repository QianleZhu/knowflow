import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  agentListQuerySchema,
  agentListResponseSchema,
  agentTraceDetailResponseSchema,
  agentTraceListResponseSchema,
  agentTracePayloadResponseSchema,
  agentTraceRouteParamsSchema,
  answerFeedbackRequestSchema,
  askMessageRequestSchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  conversationMessagesResponseSchema,
  conversationSchema,
  createConversationRequestSchema,
  uuidParamSchema,
  agentRunEventsQuerySchema,
  agentRunListResponseSchema,
  agentRunRequestParamsSchema,
  agentRunRouteParamsSchema,
  agentRunSnapshotSchema,
  type AgentListResponse,
  type AgentTraceDetailResponse,
  type AgentTraceListResponse,
  type AgentTracePayloadResponse,
  type AgentRunListResponse,
  type AgentRunSnapshot,
  type Conversation,
  type ConversationListResponse,
  type ConversationMessagesResponse,
} from "@knowflow/shared";

import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { AuthenticatedRequest } from "../../../shared/guards/auth.guard.js";
import { AgentService } from "./agent.service.js";
import { AgentRunService } from "./agent-run.service.js";

type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type EmptySuccess = ApiSuccess<Record<string, never>>;

type SseResponse = {
  status: (statusCode: number) => SseResponse;
  setHeader: (name: string, value: string) => void;
  write: (chunk: string) => boolean;
  end: () => void;
  flushHeaders?: () => void;
  on: (event: "close" | "drain", listener: () => void) => SseResponse;
  once: (event: "close" | "drain", listener: () => void) => SseResponse;
  off: (event: "close" | "drain", listener: () => void) => SseResponse;
  writableEnded: boolean;
  destroyed: boolean;
};

@Controller()
export class AgentController {
  constructor(
    @Inject(AgentService)
    private readonly agentService: AgentService,
    @Inject(AgentRunService)
    private readonly agentRunService: AgentRunService,
  ) {}

  @Get("agents")
  async listAgents(
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentListResponse>> {
    const input = agentListQuerySchema.parse(query);
    const data = await this.agentService.listAgents(this.requireUser(request), input);
    return { ok: true, data: agentListResponseSchema.parse(data) };
  }

  @Post("conversations")
  async createConversation(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<Conversation>> {
    const input = createConversationRequestSchema.parse(body);
    const data = await this.agentService.createConversation(input, this.requireUser(request));
    return { ok: true, data: conversationSchema.parse(data) };
  }

  @Get("conversations")
  async listConversations(
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<ConversationListResponse>> {
    const input = conversationListQuerySchema.parse(query);
    const data = await this.agentService.listConversations(this.requireUser(request), input);
    return { ok: true, data: conversationListResponseSchema.parse(data) };
  }

  @Post("conversations/:id/archive")
  async archiveConversation(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<Conversation>> {
    const { id } = uuidParamSchema.parse(params);
    const data = await this.agentService.archiveConversation(id, this.requireUser(request));
    return { ok: true, data: conversationSchema.parse(data) };
  }

  @Post("conversations/:id/restore")
  async restoreConversation(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<Conversation>> {
    const { id } = uuidParamSchema.parse(params);
    const data = await this.agentService.restoreConversation(id, this.requireUser(request));
    return { ok: true, data: conversationSchema.parse(data) };
  }

  @Get("conversations/:id/messages")
  async listMessages(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<ConversationMessagesResponse>> {
    const { id } = uuidParamSchema.parse(params);
    const data = await this.agentService.listMessages(id, this.requireUser(request));
    return { ok: true, data: conversationMessagesResponseSchema.parse(data) };
  }

  // 会话 Trace 列表只返回状态、时长和用量摘要，不包含原始内容。
  @Get("conversations/:id/traces")
  async listTraces(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentTraceListResponse>> {
    const { id } = uuidParamSchema.parse(params);
    const data = await this.agentService.listTraces(id, this.requireUser(request));
    return { ok: true, data: agentTraceListResponseSchema.parse(data) };
  }

  // 会话创建者可读取 Trace 时间线；Service 会在数据库查询前校验会话归属。
  @Get("conversations/:id/traces/:traceId")
  async getTraceDetail(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentTraceDetailResponse>> {
    const { id, traceId } = agentTraceRouteParamsSchema.parse(params);
    const data = await this.agentService.getTraceDetail(id, traceId, this.requireUser(request));
    return { ok: true, data: agentTraceDetailResponseSchema.parse(data) };
  }

  // 单独读取一个 Span 的原始载荷，便于大检索结果按需加载且再次授权。
  @Get("conversations/:id/traces/:traceId/spans/:spanId/payload")
  async getTraceSpanPayload(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentTracePayloadResponse>> {
    const { id, traceId, spanId } = agentTraceRouteParamsSchema.parse(params);
    if (spanId === undefined) throw new InternalServerErrorException("Trace Span 参数缺失");
    const data = await this.agentService.getTraceSpanPayload(
      id,
      traceId,
      spanId,
      this.requireUser(request),
    );
    return { ok: true, data: agentTracePayloadResponseSchema.parse(data) };
  }

  // 接收带幂等键的问题并返回独立运行快照，后续 SSE 断开不会取消 Agent。
  @Post("conversations/:id/messages")
  @HttpCode(202)
  async ask(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentRunSnapshot>> {
    const { id } = uuidParamSchema.parse(params);
    const input = askMessageRequestSchema.parse(body);
    const user = this.requireUser(request);
    const data = await this.agentRunService.startRun({
      conversationId: id,
      content: input.content,
      clientRequestId: input.clientRequestId,
      user,
    });
    return { ok: true, data: agentRunSnapshotSchema.parse(data) };
  }

  // 读取会话最近运行，为刷新页面后的流恢复和失败部分答案恢复提供数据。
  @Get("conversations/:id/runs")
  async listRuns(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentRunListResponse>> {
    const { id } = uuidParamSchema.parse(params);
    const data = await this.agentRunService.listConversationRuns(id, this.requireUser(request));
    return { ok: true, data: agentRunListResponseSchema.parse(data) };
  }

  // 查询幂等键关联的已有运行，用 GET 恢复发送响应丢失时的运行 ID。
  @Get("runs/by-request/:clientRequestId")
  async getRunByRequestId(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentRunSnapshot>> {
    const { clientRequestId } = agentRunRequestParamsSchema.parse(params);
    const data = await this.agentRunService.getRunByRequestId(
      clientRequestId,
      this.requireUser(request),
    );
    return { ok: true, data: agentRunSnapshotSchema.parse(data) };
  }

  // 按运行 ID 读取 PostgreSQL 中的答案快照、助手消息和终态。
  @Get("runs/:runId")
  async getRun(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentRunSnapshot>> {
    const { runId } = agentRunRouteParamsSchema.parse(params);
    const data = await this.agentRunService.getRun(runId, this.requireUser(request));
    return { ok: true, data: agentRunSnapshotSchema.parse(data) };
  }

  // 显式提交取消请求，让 Worker 完成模型中止和 AgentTrace 收尾。
  @Post("runs/:runId/cancel")
  async cancelRun(
    @Param() params: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ApiSuccess<AgentRunSnapshot>> {
    const { runId } = agentRunRouteParamsSchema.parse(params);
    const data = await this.agentRunService.cancelRun(runId, this.requireUser(request));
    return { ok: true, data: agentRunSnapshotSchema.parse(data) };
  }

  // 只订阅 Redis Stream 中已有运行事件；重连从 afterSequence 回放且不创建生成任务。
  @Get("runs/:runId/events")
  async streamRunEvents(
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() response: SseResponse,
  ): Promise<void> {
    const { runId } = agentRunRouteParamsSchema.parse(params);
    const { afterSequence } = agentRunEventsQuerySchema.parse(query);
    const user = this.requireUser(request);
    let sequence = afterSequence;
    let closed = false;
    let lastHeartbeatAt = Date.now();
    // 通过闭包读取异步 close 事件更新的连接状态，控制阻塞等待生命周期。
    const isClosed = (): boolean => closed;

    // 先完成对象级授权，避免向未授权调用者泄露这是一个有效 run。
    await this.agentRunService.readRunEvents(runId, sequence, user);
    const eventWaiter = this.agentRunService.createRunEventWaiter(runId);
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();

    const handleClose = (): void => {
      closed = true;
      eventWaiter.close();
    };
    response.on("close", handleClose);
    try {
      while (!isClosed()) {
        const batch = await this.agentRunService.readRunEvents(runId, sequence, user);
        if (isClosed()) break;
        if (batch.snapshotRequired) {
          const packet = {
            type: "snapshot_required" as const,
            runId,
            minSequence: batch.minSequence,
          };
          await this.writeSse(response, `data: ${JSON.stringify(packet)}\n\n`);
          break;
        }
        for (const event of batch.events) {
          if (isClosed()) break;
          await this.writeSse(
            response,
            `id: ${String(event.sequence)}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          sequence = event.sequence;
        }
        if (
          (batch.status === "completed" ||
            batch.status === "failed" ||
            batch.status === "cancelled") &&
          sequence >= batch.lastSequence
        ) {
          break;
        }
        if (Date.now() - lastHeartbeatAt >= 15_000) {
          await this.writeSse(response, `: heartbeat ${String(Date.now())}\n\n`);
          lastHeartbeatAt = Date.now();
        }
        if (batch.waitingForCheckpoint) {
          // 最近的缺口还未进入正文快照，短暂等待而不误发过期快照要求。
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        if (batch.events.length === 0) {
          const waitMs = Math.max(1, 15_000 - (Date.now() - lastHeartbeatAt));
          try {
            // 使用独立连接阻塞等新 Stream 条目，避免共享 Redis 连接被 BLOCK 占用。
            await eventWaiter.wait(batch.lastStreamId, waitMs);
          } catch {
            if (isClosed()) break;
            // Redis 不可用时保留快照兜底，短间隔重查数据库，不取消后台运行。
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (isClosed()) break;
          if (Date.now() - lastHeartbeatAt >= 15_000) {
            await this.writeSse(response, `: heartbeat ${String(Date.now())}\n\n`);
            lastHeartbeatAt = Date.now();
          }
        }
      }
    } finally {
      response.off("close", handleClose);
      eventWaiter.close();
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  }

  // 遵守 Node 响应背压，客户端读取慢时暂停 Redis 事件读取而不无限累积待写数据。
  private async writeSse(response: SseResponse, chunk: string): Promise<void> {
    if (response.destroyed || response.writableEnded) return;
    if (response.write(chunk)) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        response.off("drain", finish);
        response.off("close", finish);
        resolve();
      };
      response.once("drain", finish);
      response.once("close", finish);
    });
  }

  @Post("messages/:id/feedback")
  async createFeedback(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<EmptySuccess> {
    const { id } = uuidParamSchema.parse(params);
    const input = answerFeedbackRequestSchema.parse(body);
    await this.agentService.createFeedback(id, input, this.requireUser(request));
    return { ok: true, data: {} };
  }

  private requireUser(request: AuthenticatedRequest): AuthenticatedUser {
    if (request.user === undefined) {
      throw new InternalServerErrorException("已认证请求缺少用户信息");
    }

    return request.user;
  }
}
