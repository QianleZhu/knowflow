import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type AgentTraceSpanKind =
  | "agent"
  | "agent_step"
  | "model"
  | "embedding"
  | "rerank"
  | "retrieval";
export type AgentTraceSpanStatus = "running" | "completed" | "failed";
export type AgentTraceUsageSource = "provider" | "unknown";

export type AgentTracePriceSnapshot = {
  region: string;
  version: string;
  currency: "CNY";
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
};

export type AgentTraceSpanRecord = {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  sequence: number;
  name: string;
  kind: AgentTraceSpanKind;
  status: AgentTraceSpanStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: AgentTraceUsageSource | null;
  estimatedCostCny: string | null;
  priceSnapshot: AgentTracePriceSnapshot | Record<string, never>;
  error: string | null;
};

export type AgentTracePayloadRecord = {
  spanId: string;
  payloadType: string;
  payload: unknown;
};

export type AgentTraceUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  unknownUsageCount: number;
  estimatedCostCny: string | null;
};

type AgentTraceScope = {
  collector: AgentTraceCollector;
  parentSpanId: string;
};

type ModelPrice = {
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
};

// 单价作为可追溯快照保存；该版本按中国内地北京地域公开标准价，不含折扣和免费额度。
const TRACE_PRICE_VERSION = "2026-10-11";
const TRACE_PRICE_REGION = "cn-beijing";
const traceScopeStorage = new AsyncLocalStorage<AgentTraceScope>();

// 返回调用时模型对应的标准价；qwen-plus 按输入长度阶梯定价。
function getModelPrice(model: string, inputTokens: number | null): ModelPrice | null {
  if (model === "qwen-plus") {
    const tokens = inputTokens ?? 0;
    if (tokens > 256_000) return { inputCnyPerMillion: 4.8, outputCnyPerMillion: 48 };
    if (tokens > 128_000) return { inputCnyPerMillion: 2.4, outputCnyPerMillion: 20 };
    return { inputCnyPerMillion: 0.8, outputCnyPerMillion: 2 };
  }
  if (model === "qwen-turbo") return { inputCnyPerMillion: 0.3, outputCnyPerMillion: 0.6 };
  if (model === "text-embedding-v4" || model === "qwen3-rerank") {
    return { inputCnyPerMillion: 0.5, outputCnyPerMillion: 0 };
  }
  return null;
}

// 可由运行节点写入输入、输出和实际用量的 Span 句柄。
export class AgentTraceSpanHandle {
  // 将句柄绑定到 Collector 的单条 Span 记录。
  constructor(
    private readonly collector: AgentTraceCollector,
    readonly record: AgentTraceSpanRecord,
  ) {}

  // 保存经权限隔离的原始运行载荷；调用者不得传入密钥或认证头。
  addPayload(payloadType: string, payload: unknown): void {
    this.collector.addPayload(this.record.id, payloadType, payload);
  }

  // 保存模型标识及当前标准价快照。
  setModel(model: string): void {
    this.record.model = model;
    this.record.usageSource = "unknown";
    this.record.priceSnapshot = {};
  }

  // 保存供应商实际返回的 Token 用量，并依据当时费率估算人民币成本。
  setProviderUsage(usage: { inputTokens: number; outputTokens: number }): void {
    this.record.inputTokens = usage.inputTokens;
    this.record.outputTokens = usage.outputTokens;
    this.record.usageSource = "provider";
    this.applyPriceSnapshot(usage.inputTokens);
    if (Object.keys(this.record.priceSnapshot).length === 0) {
      this.record.estimatedCostCny = null;
      return;
    }
    const price = this.record.priceSnapshot as AgentTracePriceSnapshot;
    const estimatedCost =
      (usage.inputTokens * price.inputCnyPerMillion +
        usage.outputTokens * price.outputCnyPerMillion) /
      1_000_000;
    this.record.estimatedCostCny = estimatedCost.toFixed(12);
  }

  // 以失败状态结束调用并保存可供排查的错误摘要。
  fail(error: unknown): void {
    this.finish("failed", error);
  }

  // 完成 Span；重复结束不会覆盖第一次记录的结果。
  finish(status: AgentTraceSpanStatus = "completed", error?: unknown): void {
    if (this.record.status !== "running" && status !== "failed") return;
    const finishedAt = new Date();
    this.record.status = status;
    this.record.finishedAt = finishedAt;
    this.record.durationMs = Math.max(0, finishedAt.getTime() - this.record.startedAt.getTime());
    if (error !== undefined) this.record.error = errorMessage(error);
  }

  // 根据当前输入用量刷新阶梯费率快照。
  private applyPriceSnapshot(inputTokens: number | null): void {
    const price = this.record.model === null ? null : getModelPrice(this.record.model, inputTokens);
    this.record.priceSnapshot =
      price === null
        ? {}
        : {
            region: TRACE_PRICE_REGION,
            version: TRACE_PRICE_VERSION,
            currency: "CNY",
            ...price,
          };
  }
}

// 在一次用户查询的生命周期中暂存所有 Span 和载荷，供结束时批量写入。
export class AgentTraceCollector {
  readonly id: string;
  readonly startedAt: Date;
  readonly root: AgentTraceSpanHandle;
  private nextSequence = 0;
  private readonly spans: AgentTraceSpanHandle[] = [];
  private readonly payloads: AgentTracePayloadRecord[] = [];

  // 初始化以 Trace ID 为根 Span ID 的单次 Agent 调用采集器。
  constructor(input: { id?: string; startedAt?: Date } = {}) {
    this.id = input.id ?? randomUUID();
    this.startedAt = input.startedAt ?? new Date();
    const rootRecord: AgentTraceSpanRecord = {
      id: this.id,
      traceId: this.id,
      parentSpanId: null,
      sequence: this.nextSequence++,
      name: "agent.run",
      kind: "agent",
      status: "running",
      startedAt: this.startedAt,
      finishedAt: null,
      durationMs: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      usageSource: null,
      estimatedCostCny: null,
      priceSnapshot: {},
      error: null,
    };
    this.root = new AgentTraceSpanHandle(this, rootRecord);
    this.spans.push(this.root);
  }

  // 创建有序 Span 记录并加入请求内存缓冲区。
  createSpan(input: {
    name: string;
    kind: AgentTraceSpanKind;
    parentSpanId: string | null;
    startedAt?: Date;
  }): AgentTraceSpanHandle {
    const record: AgentTraceSpanRecord = {
      id: randomUUID(),
      traceId: this.id,
      parentSpanId: input.parentSpanId,
      sequence: this.nextSequence++,
      name: input.name,
      kind: input.kind,
      status: "running",
      startedAt: input.startedAt ?? new Date(),
      finishedAt: null,
      durationMs: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      usageSource: null,
      estimatedCostCny: null,
      priceSnapshot: {},
      error: null,
    };
    const span = new AgentTraceSpanHandle(this, record);
    this.spans.push(span);
    return span;
  }

  // 将具名载荷挂到所属 Span，保留原始对象以便完整还原调用。
  addPayload(spanId: string, payloadType: string, payload: unknown): void {
    if (payload === undefined) return;
    this.payloads.push({ spanId, payloadType, payload });
  }

  // 写入 Trace 根 Span 的最终状态和回答快照。
  finishRoot(status: AgentTraceSpanStatus, error?: unknown): void {
    this.root.finish(status, error);
  }

  // 将 Trace 写入节点标记为失败，避免事务回滚后仍显示为成功。
  failSpanByName(name: string, error: unknown): void {
    const span = [...this.spans].reverse().find((item) => item.record.name === name);
    span?.fail(error);
  }

  // 汇总供应商实际 Token 和标准价估算成本，未返回用量时总成本保持未知。
  getUsageSummary(): AgentTraceUsageSummary {
    const modelSpans = this.spans
      .map((span) => span.record)
      .filter((span) => ["model", "embedding", "rerank"].includes(span.kind));
    const unknownUsageCount = modelSpans.filter(
      (span) => span.usageSource !== "provider" || span.estimatedCostCny === null,
    ).length;
    const inputTokens = modelSpans.reduce((total, span) => total + (span.inputTokens ?? 0), 0);
    const outputTokens = modelSpans.reduce((total, span) => total + (span.outputTokens ?? 0), 0);
    const knownCost = modelSpans.reduce(
      (total, span) => total + Number(span.estimatedCostCny ?? 0),
      0,
    );
    return {
      inputTokens,
      outputTokens,
      unknownUsageCount,
      estimatedCostCny: unknownUsageCount === 0 ? knownCost.toFixed(12) : null,
    };
  }

  // 返回批量插入 Span 和原始载荷所需的数据库行。
  toDatabaseRows(): { spans: AgentTraceSpanRecord[]; payloads: AgentTracePayloadRecord[] } {
    return {
      spans: this.spans.map((span) => span.record),
      payloads: [...this.payloads],
    };
  }
}

// 返回当前异步执行链路的 Collector 与父 Span。
export function getAgentTraceScope(): AgentTraceScope | undefined {
  return traceScopeStorage.getStore();
}

// 在当前异步链路下运行用户查询，并让其全部子调用共享独立 Collector。
export function runWithAgentTraceCollector<T>(
  collector: AgentTraceCollector,
  operation: () => Promise<T>,
): Promise<T> {
  return traceScopeStorage.run({ collector, parentSpanId: collector.root.record.id }, operation);
}

// 建立有父子关系的异步 Span，并确保成功或异常时都结束计时。
export async function withAgentTraceSpan<T>(input: {
  name: string;
  kind: AgentTraceSpanKind;
  operation: (span: AgentTraceSpanHandle | undefined) => Promise<T>;
}): Promise<T> {
  const scope = getAgentTraceScope();
  if (scope === undefined) return input.operation(undefined);

  const span = scope.collector.createSpan({
    name: input.name,
    kind: input.kind,
    parentSpanId: scope.parentSpanId,
  });
  return traceScopeStorage.run(
    { collector: scope.collector, parentSpanId: span.record.id },
    async () => {
      try {
        const result = await input.operation(span);
        span.finish();
        return result;
      } catch (error) {
        span.fail(error);
        throw error;
      }
    },
  );
}

// 为流式模型调用创建当前父 Span 的子 Span。
export function startAgentTraceSpan(input: {
  name: string;
  kind: AgentTraceSpanKind;
}): AgentTraceSpanHandle | undefined {
  const scope = getAgentTraceScope();
  if (scope === undefined) return undefined;
  return scope.collector.createSpan({
    name: input.name,
    kind: input.kind,
    parentSpanId: scope.parentSpanId,
  });
}

// 将数据附加到当前异步执行的 Span，供 Agent 步骤记录状态和结果快照。
export function recordAgentTracePayload(payloadType: string, payload: unknown): void {
  const scope = getAgentTraceScope();
  if (scope !== undefined) {
    scope.collector.addPayload(scope.parentSpanId, payloadType, payload);
  }
}

// 将错误转换为不含堆栈和供应商请求头的有限长度摘要。
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4000);
}
