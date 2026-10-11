import { Injectable } from "@nestjs/common";
import OpenAI from "openai";

import {
  resolveModelConfig,
  type ModelConfigResolver,
  type ModelUsageType,
  type ResolvedModelConfig,
} from "./model-usage-client.js";

export const EXPECTED_EMBEDDING_DIMENSION = 1024;

type ModelConfig = {
  model: string;
  temperature: number;
  maxOutputTokens: number | null;
  timeoutMs: number;
  retryCount: number;
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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
};

export type ChatStreamChunk = {
  delta: string;
};

@Injectable()
export class AliyunLlmService {
  // 使用服务端固定的嵌入模型生成文本向量。
  async embedTexts(texts: string[]): Promise<number[][]> {
    return createAliyunLlmClient().embedTexts(texts);
  }

  // 使用固定重排模型为候选文档评分。
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    instruct?: string,
  ): Promise<RerankResult[]> {
    return createAliyunLlmClient().rerank(query, documents, topN, instruct);
  }

  // 按内部用途流式生成对话内容。
  streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    temperature?: number;
    maxOutputTokens?: number;
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
  constructor(
    private readonly modelConfigResolver: ModelConfigResolver = resolveModelConfig,
  ) {}

  // 调用固定嵌入模型，并校验返回数量和向量维度。
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const config = await this.resolveModelConfig("embedding");
    const response = await this.createOpenAiClient(config).embeddings.create({
      model: config.model,
      input: texts,
    });
    if (response.data.length !== texts.length) {
      throw new Error("Embedding response count does not match input count");
    }

    return response.data.map((item) => {
      if (item.embedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
        throw new Error(`Embedding dimension mismatch: ${String(item.embedding.length)}`);
      }
      return item.embedding;
    });
  }

  // 调用固定重排模型，并校验供应商返回的候选索引与分数。
  async rerank(
    query: string,
    documents: string[],
    topN: number,
    instruct?: string,
  ): Promise<RerankResult[]> {
    if (documents.length === 0) {
      return [];
    }

    const config = await this.resolveModelConfig("rerank");
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
          body: JSON.stringify({
            model: config.model,
            query,
            documents,
            top_n: Math.min(topN, documents.length),
            ...(instruct === undefined ? {} : { instruct }),
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
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
  }

  // 按内部用途流式生成对话内容。
  async *streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<ChatStreamChunk> {
    const config = await this.resolveModelConfig(input.usageType ?? "chat");
    const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
    const stream = await this.createOpenAiClient(config).chat.completions.create({
      model: config.model,
      messages: input.messages,
      temperature: input.temperature ?? config.temperature,
      ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (typeof delta === "string" && delta.length > 0) {
        yield { delta };
      }
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
  }): Promise<string> {
    const config = await this.resolveModelConfig(input.usageType ?? "chat");
    const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
    const response = await this.createOpenAiClient(config).chat.completions.create({
      model: config.model,
      messages: input.messages,
      temperature: input.temperature ?? config.temperature,
      ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
    });

    return response.choices[0]?.message.content ?? "";
  }

  // 返回模型审计信息，不包含 API Key。
  async getModelConfig(usageType: ModelUsageType): Promise<ModelConfig> {
    const config = await this.resolveModelConfig(usageType);
    return {
      model: config.model,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
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

// 统一生成阿里云 Qwen3 Rerank 兼容接口地址，兼容模型配置中的默认 Base URL。
export function buildAliyunRerankUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  if (normalizedBaseUrl.endsWith("/compatible-api/v1")) {
    return `${normalizedBaseUrl}/reranks`;
  }

  const endpointBaseUrl = normalizedBaseUrl.replace(/\/compatible-mode\/v1$/, "");
  return `${endpointBaseUrl}/compatible-api/v1/reranks`;
}
