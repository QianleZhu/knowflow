import { Injectable } from "@nestjs/common";
import type { ModelUsageType } from "@knowflow/shared";
import OpenAI from "openai";

import { resolveModelConfig, type ResolvedModelConfig } from "./model-usage-client.js";

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
  async embedTexts(texts: string[], model?: string): Promise<number[][]> {
    return createAliyunLlmClient().embedTexts(texts, model);
  }

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    model?: string,
    instruct?: string,
  ): Promise<RerankResult[]> {
    return createAliyunLlmClient().rerank(query, documents, topN, model, instruct);
  }

  streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<ChatStreamChunk> {
    return createAliyunLlmClient().streamChat(input);
  }

  async completeChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<
      ModelUsageType,
      "chat" | "query_understanding" | "agent_generation" | "knowledge_production"
    >;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<string> {
    return createAliyunLlmClient().completeChat(input);
  }

  async getModelConfig(usageType: ModelUsageType): Promise<ModelConfig> {
    return createAliyunLlmClient().getModelConfig(usageType);
  }
}

export function createAliyunLlmClient(): AliyunLlmClient {
  return new AliyunLlmClient();
}

export class AliyunLlmClient {
  constructor(
    private readonly modelConfigResolver: (
      usageType: ModelUsageType,
    ) => Promise<ResolvedModelConfig> = resolveModelConfig,
  ) {}

  async embedTexts(texts: string[], model?: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const config = await this.resolveModelConfig("embedding");
    const response = await this.createOpenAiClient(config).embeddings.create({
      model: model ?? config.model,
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

  async rerank(
    query: string,
    documents: string[],
    topN: number,
    model?: string,
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
            model: model ?? config.model,
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

  async *streamChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<ModelUsageType, "chat" | "query_understanding">;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): AsyncIterable<ChatStreamChunk> {
    const config = await this.resolveModelConfig(input.usageType ?? "chat");
    const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
    const stream = await this.createOpenAiClient(config).chat.completions.create({
      model: input.model ?? config.model,
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

  async completeChat(input: {
    messages: ChatMessage[];
    usageType?: Extract<
      ModelUsageType,
      "chat" | "query_understanding" | "agent_generation" | "knowledge_production"
    >;
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<string> {
    const config = await this.resolveModelConfig(input.usageType ?? "chat");
    const maxTokens = input.maxOutputTokens ?? config.maxOutputTokens;
    const response = await this.createOpenAiClient(config).chat.completions.create({
      model: input.model ?? config.model,
      messages: input.messages,
      temperature: input.temperature ?? config.temperature,
      ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
    });

    return response.choices[0]?.message.content ?? "";
  }

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

  private async resolveModelConfig(usageType: ModelUsageType): Promise<ResolvedModelConfig> {
    return this.modelConfigResolver(usageType);
  }

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
