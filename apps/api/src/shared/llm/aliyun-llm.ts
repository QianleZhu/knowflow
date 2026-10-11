import { Injectable } from "@nestjs/common";
import OpenAI from "openai";

import {
  resolveModelConfig,
  type ModelConfigResolver,
  type ModelUsageType,
  type ResolvedModelConfig,
} from "./model-usage-client.js";
import { startAgentTraceSpan } from "../tracing/agent-trace-collector.js";

export const EXPECTED_EMBEDDING_DIMENSION = 1024;

type ModelConfig = {
  model: string;
  temperature: number;
  maxOutputTokens: number | null;
  contextWindowTokens: number | null;
  maxInputTokens: number | null;
  timeoutMs: number;
  retryCount: number;
};

export type ChatRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatMessage = ChatRequestMessage;

export type ChatTokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type RerankResult = {
  index: number;
  relevanceScore: number;
};

type Qwen3RerankResponse = {
  results?: {
    index?: number;
    relevance_score?: number;
  }[];
  usage?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
  };
};

export type ChatStreamChunk = {
  delta: string;
  usage?: ChatTokenUsage;
};

@Injectable()
export class AliyunLlmService {
  // 使用服务端固定的嵌入模型生成文本向量。
  async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return createAliyunLlmClient().embedTexts(texts, signal);
  }

  // 使用固定重排模型为候选文档评分。
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    instruct?: string,
    signal?: AbortSignal,
  ): Promise<RerankResult[]> {
    return createAliyunLlmClient().rerank(query, documents, topN, instruct, signal);
  }

  // 按内部用途流式生成对话内容。
  streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<ChatStreamChunk> {
    return createAliyunLlmClient().streamChat(input);
  }

  // 按内部用途生成非流式对话内容。
  async completeChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<
      ModelUsageType,
      "chat" | "query_understanding" | "agent_generation" | "knowledge_production"
    >;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    return createAliyunLlmClient().completeChat(input);
  }

  // 返回可写入运行追踪的模型参数，不包含 API Key。
  async getModelConfig(usageType: ModelUsageType): Promise<ModelConfig> {
    return createAliyunLlmClient().getModelConfig(usageType);
  }
}

// 创建默认运行时模型客户端。
export function createAliyunLlmClient(): AliyunLlmClient {
  return new AliyunLlmClient();
}

export class AliyunLlmClient {
  // 允许调用方注入配置解析器，便于在隔离环境中验证客户端行为。
  constructor(private readonly modelConfigResolver: ModelConfigResolver = resolveModelConfig) {}

  // 调用固定嵌入模型，并校验返回数量和向量维度。
  async embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const span = startAgentTraceSpan({ name: "model.embedding", kind: "embedding" });
    try {
      const config = await this.resolveModelConfig("embedding");
      span?.setModel(config.model);
      span?.addPayload("request", { model: config.model, input: texts });
      const response = await this.createOpenAiClient(config).embeddings.create(
        {
          model: config.model,
          input: texts,
        },
        { signal },
      );
      span?.addPayload("response", {
        ...response,
      });
      const embeddingInputTokens = readPromptTokenCount(response.usage);
      if (embeddingInputTokens !== null) {
        span?.setProviderUsage({ inputTokens: embeddingInputTokens, outputTokens: 0 });
      }
      if (response.data.length !== texts.length) {
        throw new Error("Embedding response count does not match input count");
      }

      return response.data.map((item) => {
        if (item.embedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
          throw new Error(`Embedding dimension mismatch: ${String(item.embedding.length)}`);
        }
        return item.embedding;
      });
    } catch (error) {
      if (signal?.aborted) span?.cancel(error);
      else span?.fail(error);
      throw error;
    } finally {
      span?.finish();
    }
  }

  // 调用固定重排模型，并校验供应商返回的候选索引与分数。
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    instruct?: string,
    signal?: AbortSignal,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) {
      return [];
    }

    const span = startAgentTraceSpan({ name: "model.rerank", kind: "rerank" });
    try {
      const config = await this.resolveModelConfig("rerank");
      span?.setModel(config.model);
      const requestBody = {
        model: config.model,
        query,
        documents,
        top_n: Math.min(topN, documents.length),
        ...(instruct === undefined ? {} : { instruct }),
      };
      span?.addPayload("request", requestBody);
      const requestUrl = process.env["ALIYUN_RERANK_URL"] ?? buildAliyunRerankUrl(config.baseUrl);
      const maxAttempts = Math.max(1, config.retryCount + 1);

      // 按供应商配置执行有限重试，并只对限流、服务端错误和网络异常重试。
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(requestUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal:
              signal === undefined
                ? AbortSignal.timeout(config.timeoutMs)
                : AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
          });
        } catch {
          if (signal?.aborted) throw new DOMException("用户已停止生成", "AbortError");
          if (attempt === maxAttempts) {
            throw new Error("Model provider request failed");
          }
          continue;
        }

        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
            continue;
          }
          throw new Error("Model provider request failed");
        }

        const body = (await response.json()) as Qwen3RerankResponse;
        span?.addPayload("response", body);
        const rerankTokens =
          body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? body.usage?.total_tokens;
        if (rerankTokens !== undefined) {
          span?.setProviderUsage({
            inputTokens: rerankTokens,
            outputTokens: body.usage?.output_tokens ?? 0,
          });
        }
        const results = body.results;
        if (!Array.isArray(results)) {
          throw new Error("Aliyun rerank response is invalid");
        }
        // LLM输出格式校验防重复
        const seenIndexes = new Set<number>();
        const normalizedResults = results.map((item) => {
          const index = item.index;
          const relevanceScore = item.relevance_score;
          if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= documents.length ||
            seenIndexes.has(index) ||
            typeof relevanceScore !== "number" ||
            !Number.isFinite(relevanceScore) ||
            relevanceScore < 0 ||
            relevanceScore > 1
          ) {
            throw new Error("Aliyun rerank response is invalid");
          }
          seenIndexes.add(index);
          return { index, relevanceScore };
        });

        return normalizedResults
          .sort((left, right) => right.relevanceScore - left.relevanceScore)
          .slice(0, Math.min(topN, documents.length));
      }

      throw new Error("Model provider request failed");
    } catch (error) {
      if (signal?.aborted) span?.cancel(error);
      else span?.fail(error);
      throw error;
    } finally {
      span?.finish();
    }
  }

  // 按内部用途流式生成对话内容。
  async *streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<ChatStreamChunk> {
    const span = startAgentTraceSpan({ name: "model.chat.stream", kind: "model" });
    let responseText = "";
    let responseUsage: ChatTokenUsage | null = null;
    let finishReason: string | null = null;
    try {
      const config = await this.resolveModelConfig(input.usageType ?? "chat");
      span?.setModel(config.model);
      const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
      const requestBody = {
        model: config.model,
        messages: input.messages,
        temperature: input.temperature ?? config.temperature,
        ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
        stream: true as const,
        stream_options: { include_usage: true },
      };
      span?.addPayload("request", requestBody);
      const stream = await this.createOpenAiClient(config).chat.completions.create(
        {
          ...requestBody,
        },
        { signal: input.signal },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta.content;
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
        const usage =
          chunk.usage === null || chunk.usage === undefined
            ? undefined
            : {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
              };
        if (typeof delta === "string" && delta.length > 0) {
          responseText += delta;
          yield { delta, ...(usage === undefined ? {} : { usage }) };
        } else if (usage !== undefined) {
          yield { delta: "", usage };
        }
        if (usage !== undefined) {
          responseUsage = usage;
          span?.setProviderUsage(usage);
        }
      }
      span?.addPayload("response", {
        content: responseText,
        usage: responseUsage,
        finishReason,
      });
    } catch (error) {
      span?.addPayload("partial_response", { content: responseText });
      if (input.signal?.aborted) span?.cancel(error);
      else span?.fail(error);
      throw error;
    } finally {
      span?.finish();
    }
  }

  // 按内部用途生成非流式对话内容。
  async completeChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<
      ModelUsageType,
      "chat" | "query_understanding" | "agent_generation" | "knowledge_production"
    >;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const span = startAgentTraceSpan({ name: "model.chat.complete", kind: "model" });
    try {
      const config = await this.resolveModelConfig(input.usageType ?? "chat");
      span?.setModel(config.model);
      const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
      const requestBody = {
        model: config.model,
        messages: input.messages,
        temperature: input.temperature ?? config.temperature,
        ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
      };
      span?.addPayload("request", requestBody);
      const response = await this.createOpenAiClient(config).chat.completions.create(
        { ...requestBody },
        { signal: input.signal },
      );
      const content = response.choices[0]?.message.content ?? "";
      span?.addPayload("response", {
        ...response,
      });
      const usage = readChatTokenUsage(response.usage);
      if (usage !== null) span?.setProviderUsage(usage);
      return content;
    } catch (error) {
      if (input.signal?.aborted) span?.cancel(error);
      else span?.fail(error);
      throw error;
    } finally {
      span?.finish();
    }
  }

  // 返回模型审计信息，不包含 API Key。
  async getModelConfig(usageType: ModelUsageType): Promise<ModelConfig> {
    const config = await this.resolveModelConfig(usageType);
    return {
      model: config.model,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      contextWindowTokens: config.contextWindowTokens ?? null,
      maxInputTokens: config.maxInputTokens ?? null,
      timeoutMs: config.timeoutMs,
      retryCount: config.retryCount,
    };
  }

  // 按用途取得不可由调用参数覆盖的模型配置。
  private async resolveModelConfig(usageType: ModelUsageType): Promise<ResolvedModelConfig> {
    return this.modelConfigResolver(usageType);
  }

  // 使用统一超时、重试和环境 Key 创建 OpenAI 兼容客户端。
  private createOpenAiClient(config: ResolvedModelConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: config.retryCount,
    });
  }
}

// 读取聊天模型供应商的实际 Token usage；响应缺少字段时保留未知状态。
function readChatTokenUsage(value: unknown): ChatTokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = usage["prompt_tokens"];
  const outputTokens = usage["completion_tokens"];
  if (
    typeof inputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0
  ) {
    return null;
  }
  return { inputTokens, outputTokens };
}

// 读取嵌入接口的实际输入 Token；供应商缺少 usage 时保留未知，不影响向量结果。
function readPromptTokenCount(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const promptTokens = (value as Record<string, unknown>)["prompt_tokens"];
  return typeof promptTokens === "number" && Number.isInteger(promptTokens) && promptTokens >= 0
    ? promptTokens
    : null;
}

// 统一生成阿里云 Qwen3 Rerank 兼容接口地址，兼容模型配置中的默认 Base URL。
export function buildAliyunRerankUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  if (normalizedBaseUrl.endsWith("/compatible-api/v1")) {
    return `${normalizedBaseUrl}/reranks`;
  }

  const endpointBaseUrl = normalizedBaseUrl.replace(/\/compatible-mode\/v1$/, "");
  return `${endpointBaseUrl}/compatible-api/v1/reranks`;
}
