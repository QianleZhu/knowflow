import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type ModelUsageType =
  | "chat"
  | "query_understanding"
  | "document_processing"
  | "embedding"
  | "rerank"
  | "ocr"
  | "vision"
  | "knowledge_production"
  | "agent_generation";

type ModelUsageSettings = {
  model: string;
  temperature: number;
  maxOutputTokens: number | null;
  timeoutMs: number;
  retryCount: number;
};

export type ModelUsageOptions = {
  temperature?: number;
  // null 表示明确省略输出上限，undefined 则沿用内部用途配置。
  maxOutputTokens?: number | null;
};

export type ResolvedModelConfig = ModelUsageSettings & {
  baseUrl: string;
  apiKey: string;
};

export type ModelConfigResolver = (
  usageType: ModelUsageType,
) => ResolvedModelConfig | Promise<ResolvedModelConfig>;

export type ModelUsageMessage = ChatCompletionMessageParam;

// 内部固定各模型用途映射；模型名称不会从请求、数据库或用户配置中读取。
const MODEL_USAGE_SETTINGS = {
  chat: {
    model: "qwen-plus",
    temperature: 0.7,
    maxOutputTokens: 4096,
    timeoutMs: 30000,
    retryCount: 2,
  },
  query_understanding: {
    model: "qwen-turbo",
    temperature: 0.7,
    maxOutputTokens: 1024,
    timeoutMs: 30000,
    retryCount: 2,
  },
  document_processing: {
    model: "qwen-plus",
    temperature: 0.7,
    maxOutputTokens: 2048,
    timeoutMs: 30000,
    retryCount: 2,
  },
  embedding: {
    model: "text-embedding-v4",
    temperature: 0,
    maxOutputTokens: null,
    timeoutMs: 30000,
    retryCount: 2,
  },
  rerank: {
    model: "qwen3-rerank",
    temperature: 0,
    maxOutputTokens: null,
    timeoutMs: 30000,
    retryCount: 2,
  },
  ocr: {
    model: "qwen-vl-plus",
    temperature: 0.7,
    maxOutputTokens: null,
    timeoutMs: 30000,
    retryCount: 2,
  },
  vision: {
    model: "qwen-vl-plus",
    temperature: 0.7,
    maxOutputTokens: null,
    timeoutMs: 30000,
    retryCount: 2,
  },
  knowledge_production: {
    model: "qwen-plus",
    temperature: 0.7,
    maxOutputTokens: 2048,
    timeoutMs: 30000,
    retryCount: 2,
  },
  agent_generation: {
    model: "qwen-plus",
    temperature: 0.7,
    maxOutputTokens: 2048,
    timeoutMs: 30000,
    retryCount: 2,
  },
} satisfies Record<ModelUsageType, ModelUsageSettings>;

const DEFAULT_ALIYUN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// 根据内部用途设置和环境变量组装模型调用配置。
export function resolveModelConfig(usageType: ModelUsageType): ResolvedModelConfig {
  const settings = MODEL_USAGE_SETTINGS[usageType];
  const apiKey = process.env["ALIYUN_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ALIYUN_API_KEY is not configured");
  }

  const configuredBaseUrl = process.env["ALIYUN_BASE_URL"]?.trim();
  return {
    ...settings,
    baseUrl:
      configuredBaseUrl === undefined || configuredBaseUrl.length === 0
        ? DEFAULT_ALIYUN_BASE_URL
        : configuredBaseUrl,
    apiKey,
  };
}

// 按内部用途调用非流式模型，并保留 OCR 完整响应校验。
export async function callModelByUsage(
  usageType: ModelUsageType,
  messages: ModelUsageMessage[],
  options: ModelUsageOptions = {},
  resolveConfig: ModelConfigResolver = resolveModelConfig,
): Promise<string> {
  const config = await resolveConfig(usageType);
  // 显式 null 不能通过 ?? 回退，否则 OCR 仍会受到用途配置里的上限影响。
  const maxTokens =
    options.maxOutputTokens === null ? null : (options.maxOutputTokens ?? config.maxOutputTokens);
  const response = await new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    maxRetries: config.retryCount,
  }).chat.completions.create({
    model: config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
  });

  // OCR 的截断响应不能当成完整页面落库；由页面解析器重试或报告失败。
  if (usageType === "ocr" && response.choices[0]?.finish_reason !== "stop") {
    throw new Error(
      "OCR 响应未完整结束（" + (response.choices[0]?.finish_reason ?? "missing_choice") + "）",
    );
  }
  return response.choices[0]?.message.content ?? "";
}
