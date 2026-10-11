import {
  Body,
  Controller,
  Get,
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
  type AgentListResponse,
  type AgentTraceDetailResponse,
  type AgentTraceListResponse,
  type AgentTracePayloadResponse,
  type Conversation,
  type ConversationListResponse,
  type ConversationMessagesResponse,
} from "@knowflow/shared";

import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { AuthenticatedRequest } from "../../../shared/guards/auth.guard.js";
import { AgentService } from "./agent.service.js";

type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type EmptySuccess = ApiSuccess<Record<string, never>>;

type SseResponse = {
  status: (statusCode: number) => SseResponse;
  setHeader: (name: string, value: string) => void;
  write: (chunk: string) => void;
  end: () => void;
  on: (event: "close", listener: () => void) => SseResponse;
  off: (event: "close", listener: () => void) => SseResponse;
  writableEnded: boolean;
  destroyed: boolean;
};

@Controller()
export class AgentController {
  constructor(
    @Inject(AgentService)
    private readonly agentService: AgentService,
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

  // 客户端断开 SSE 时中止 Agent 工作，并让服务层保存取消 Trace。
  @Post("conversations/:id/messages")
  async ask(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res() response: SseResponse,
  ): Promise<void> {
    const { id } = uuidParamSchema.parse(params);
    const input = askMessageRequestSchema.parse(body);
    const user = this.requireUser(request);

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");

    const cancellation = new AbortController();
    // 响应正常结束也会触发 close；只有未完成的响应才代表客户端提前断开。
    const handleResponseClose = (): void => {
      if (!response.writableEnded) cancellation.abort();
    };
    response.on("close", handleResponseClose);

    const writeEvent = (event: unknown): void => {
      if (cancellation.signal.aborted || response.destroyed || response.writableEnded) return;
      try {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        cancellation.abort(error);
      }
    };

    try {
      await this.agentService.ask({
        conversationId: id,
        content: input.content,
        user,
        signal: cancellation.signal,
        emit: (event) => Promise.resolve(writeEvent(event)),
      });
    } catch (error) {
      if (!cancellation.signal.aborted) {
        writeEvent({
          type: "agent.failed",
          message: error instanceof Error ? error.message : "Agent 请求失败",
        });
      }
    } finally {
      response.off("close", handleResponseClose);
      if (!response.destroyed && !response.writableEnded) response.end();
    }
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
