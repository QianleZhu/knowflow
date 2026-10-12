"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  CircleStop,
  Clock3,
  LoaderCircle,
  Search,
} from "lucide-react";
import {
  agentTraceDetailResponseSchema,
  agentTracePayloadResponseSchema,
  type AgentTraceDetailResponse,
  type AgentTracePayloadResponse,
  type AgentTraceSummary,
} from "@knowflow/shared";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { apiRequest } from "../../lib/api";
import { cn } from "../../lib/cn";

type TraceDetailsSheetProps = {
  open: boolean;
  conversationId: string;
  trace: AgentTraceSummary | null;
  onOpenChange: (open: boolean) => void;
};

// 将人民币估算成本格式化为易读金额或未知状态。
function formatCost(value: number | null): string {
  return value === null ? "含未估算调用" : `¥${value.toFixed(6)}`;
}

// 将毫秒耗时转换为短时间标签。
function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${String(value)} ms` : `${(value / 1000).toFixed(2)} 秒`;
}

// 按简体中文界面格式展示 Trace 时间。
function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

// 将服务端稳定 Span 名称映射为对话用户容易理解的中文步骤名。
function getSpanLabel(name: string): string {
  const labels: Record<string, string> = {
    "agent.run": "Agent 调用",
    load_agent: "加载 Agent 配置",
    check_agent_permission: "权限检查",
    resolve_knowledge_scope: "解析知识范围",
    parse_conversation_attachments: "加载会话上下文",
    analyze_query: "分析问题与路由",
    execute_route_tasks: "执行意图任务",
    "model.jev.intent": "Jev 多意图分类",
    rewrite_query: "查询改写",
    retrieve_knowledge: "知识检索",
    "retrieval.vector": "向量召回",
    "retrieval.fts": "全文召回",
    "retrieval.knowledge_item": "知识条目召回",
    rerank_context: "结果重排",
    build_context: "构建模型上下文",
    generate_answer_stream: "生成回答",
    record_trace: "记录 Trace",
    "model.embedding": "查询嵌入模型",
    "model.rerank": "重排模型",
    "model.chat.complete": "对话模型调用",
    "model.chat.stream": "答案生成模型",
    "route_task.knowledge_qa": "知识问答任务",
    "route_task.document_catalog": "文档目录任务",
    "route_task.access_scope": "访问范围任务",
    "route_task.assistant_capability": "助手能力任务",
    "route_task.conversation_transform": "对话整理任务",
    "route_task.general_generation": "通用生成任务",
    "route_task.unclear": "待澄清任务",
  };
  return labels[name] ?? name;
}

// 将内部 Span 分类映射为中文类别标签。
function getSpanKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    agent: "运行",
    agent_step: "步骤",
    model: "模型",
    embedding: "嵌入",
    retrieval: "检索",
    rerank: "重排",
  };
  return labels[kind] ?? kind;
}

// 展示单次用户查询的 Trace 概览、Span 时间线和按需加载的原始载荷。
export function TraceDetailsSheet({
  open,
  conversationId,
  trace,
  onOpenChange,
}: TraceDetailsSheetProps) {
  const [detail, setDetail] = useState<AgentTraceDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [payload, setPayload] = useState<AgentTracePayloadResponse | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [loadingPayload, setLoadingPayload] = useState(false);

  // 仅在打开面板时请求时间线概要，关闭后不在对话列表中保留原始载荷。
  useEffect(() => {
    if (!open || trace === null) {
      // 面板关闭或 Trace 失效时清除原始载荷，避免状态继续保留敏感内容。
      setDetail(null);
      setSelectedSpanId(null);
      setPayload(null);
      setPayloadError(null);
      setLoadingDetail(false);
      setLoadingPayload(false);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    setSelectedSpanId(null);
    setPayload(null);
    setLoadingDetail(true);
    void apiRequest(
      `/conversations/${conversationId}/traces/${trace.traceId}`,
      agentTraceDetailResponseSchema,
      { cache: "no-store", signal: controller.signal },
    )
      .then(setDetail)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDetailError(error instanceof Error ? error.message : "加载 Trace 失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });
    return () => controller.abort();
  }, [conversationId, open, trace]);

  // 用户展开某个步骤后才读取该 Span 的正文载荷，避免列表接口传输大段检索内容。
  useEffect(() => {
    if (!open || trace === null || selectedSpanId === null) {
      setPayload(null);
      setPayloadError(null);
      setLoadingPayload(false);
      return;
    }
    const controller = new AbortController();
    setPayload(null);
    setPayloadError(null);
    setLoadingPayload(true);
    void apiRequest(
      `/conversations/${conversationId}/traces/${trace.traceId}/spans/${selectedSpanId}/payload`,
      agentTracePayloadResponseSchema,
      { cache: "no-store", signal: controller.signal },
    )
      .then(setPayload)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPayloadError(error instanceof Error ? error.message : "加载步骤详情失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPayload(false);
      });
    return () => controller.abort();
  }, [conversationId, open, selectedSpanId, trace]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <SheetHeader className="border-b border-border px-6 py-5 pr-14">
          <SheetTitle className="flex items-center gap-2 text-lg text-ink">
            <Activity className="size-5 text-brand-600" />
            运行详情
          </SheetTitle>
          <SheetDescription>
            一条查询对应一次 Trace。原始请求和召回内容仅对会话创建者开放。
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {trace === null ? (
            <p className="text-sm text-ink-muted">没有可显示的运行记录。</p>
          ) : (
            <>
              <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <SummaryMetric icon={<Clock3 className="size-4" />} label="总耗时">
                  {formatDuration(trace.latencyMs)}
                </SummaryMetric>
                <SummaryMetric icon={<Activity className="size-4" />} label="Token">
                  {trace.inputTokens.toLocaleString()} 输入 · {trace.outputTokens.toLocaleString()}{" "}
                  输出
                </SummaryMetric>
                <SummaryMetric icon={<CircleDollarSign className="size-4" />} label="标准价估算">
                  {formatCost(trace.estimatedCostCny)}
                </SummaryMetric>
                <SummaryMetric icon={<Search className="size-4" />} label="处理步骤">
                  {trace.spanCount} 个 Span
                </SummaryMetric>
              </div>

              <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-medium",
                    trace.status === "completed"
                      ? "bg-success-bg text-success"
                      : trace.status === "cancelled"
                        ? "bg-warning-bg text-warning"
                        : "bg-danger-bg text-danger",
                  )}
                >
                  {trace.status === "completed"
                    ? "已完成"
                    : trace.status === "cancelled"
                      ? "已停止"
                      : "运行失败"}
                </span>
                <span>{formatTimestamp(trace.createdAt)}</span>
                <span>Trace ID：{trace.traceId}</span>
                {trace.unknownUsageCount > 0 ? (
                  <span className="text-warning">
                    {trace.unknownUsageCount} 次模型调用的用量或标准价估算不完整
                  </span>
                ) : null}
              </div>

              <div className="grid gap-5 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.15fr)]">
                <section aria-label="运行步骤">
                  <h3 className="mb-3 text-sm font-semibold text-ink">执行时间线</h3>
                  {loadingDetail ? (
                    <div className="space-y-2" aria-label="正在加载步骤">
                      <div className="h-16 animate-pulse rounded-lg bg-neutral-100" />
                      <div className="h-16 animate-pulse rounded-lg bg-neutral-100" />
                      <div className="h-16 animate-pulse rounded-lg bg-neutral-100" />
                    </div>
                  ) : detailError !== null ? (
                    <p
                      className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger"
                      role="alert"
                    >
                      {detailError}
                    </p>
                  ) : detail === null || detail.spans.length === 0 ? (
                    <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-ink-muted">
                      这条 Trace 没有可显示的执行步骤。
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {detail.spans.map((span) => {
                        const active = selectedSpanId === span.id;
                        return (
                          <li key={span.id}>
                            <button
                              type="button"
                              aria-expanded={active}
                              onClick={() => setSelectedSpanId(active ? null : span.id)}
                              className={cn(
                                "flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                                active
                                  ? "border-brand-300 bg-brand-50"
                                  : "border-border bg-surface hover:bg-neutral-50",
                              )}
                            >
                              <SpanStatus status={span.status} />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center justify-between gap-2">
                                  <span className="truncate text-sm font-medium text-ink">
                                    {getSpanLabel(span.name)}
                                  </span>
                                  <span className="shrink-0 text-xs text-ink-subtle">
                                    {formatDuration(span.durationMs)}
                                  </span>
                                </span>
                                <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-ink-subtle">
                                  <span>{getSpanKindLabel(span.kind)}</span>
                                  {span.model !== null ? <span>{span.model}</span> : null}
                                  {span.inputTokens !== null || span.outputTokens !== null ? (
                                    <span>
                                      {(span.inputTokens ?? 0).toLocaleString()} 输入 ·{" "}
                                      {(span.outputTokens ?? 0).toLocaleString()} 输出
                                    </span>
                                  ) : null}
                                  {span.estimatedCostCny !== null ? (
                                    <span>估算 {formatCost(span.estimatedCostCny)}</span>
                                  ) : span.usageSource === "unknown" ? (
                                    <span>Token 用量未知</span>
                                  ) : span.usageSource === "provider" ? (
                                    <span>成本未纳入标准价估算</span>
                                  ) : null}
                                  {span.priceSnapshot !== null ? (
                                    <span>
                                      {span.priceSnapshot.region} 标准价{" "}
                                      {span.priceSnapshot.version}
                                    </span>
                                  ) : null}
                                </span>
                                {span.error !== null ? (
                                  <span className="mt-1 block break-words text-xs text-danger">
                                    {span.error}
                                  </span>
                                ) : null}
                              </span>
                              <ChevronDown
                                className={cn(
                                  "mt-0.5 size-4 shrink-0 text-ink-subtle transition-transform",
                                  active && "rotate-180",
                                )}
                              />
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>

                <section aria-label="步骤载荷">
                  <h3 className="mb-3 text-sm font-semibold text-ink">输入、检索与输出</h3>
                  {selectedSpanId === null ? (
                    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border bg-neutral-50 px-5 text-center text-sm text-ink-muted">
                      选择左侧步骤，查看该步骤保存的原始内容。
                    </div>
                  ) : loadingPayload ? (
                    <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-border bg-neutral-50 text-sm text-ink-muted">
                      <LoaderCircle className="size-4 animate-spin" /> 正在加载步骤内容
                    </div>
                  ) : payloadError !== null ? (
                    <p
                      className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger"
                      role="alert"
                    >
                      {payloadError}
                    </p>
                  ) : payload === null ? (
                    <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-ink-muted">
                      没有保存该步骤的原始载荷。
                    </p>
                  ) : payload.payloads.length === 0 ? (
                    <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-ink-muted">
                      该步骤没有可展开的原始载荷。
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {payload.payloads.map((item, index) => (
                        <div key={`${item.type}-${String(index)}`}>
                          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                            {item.type.replaceAll("_", " ")}
                          </h4>
                          <pre className="max-h-[34rem] overflow-auto rounded-lg border border-border bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-100">
                            {JSON.stringify(item.payload, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <p className="mt-5 text-xs text-ink-subtle">
                成本为按中国内地北京公开标准价快照计算的估算值，不代表实际账单金额。
              </p>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// 用一致的卡片形式显示 Trace 的单项运行指标。
function SummaryMetric({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-subtle">
        {icon}
        {label}
      </div>
      <div className="truncate text-sm font-semibold tabular-nums text-ink">{children}</div>
    </div>
  );
}

// 用图标和颜色传达 Span 成功、失败、取消或仍在运行的状态。
function SpanStatus({ status }: { status: "running" | "completed" | "failed" | "cancelled" }) {
  if (status === "failed") return <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />;
  if (status === "cancelled") {
    return <CircleStop className="mt-0.5 size-4 shrink-0 text-warning" />;
  }
  if (status === "running") {
    return <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-warning" />;
  }
  return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />;
}
