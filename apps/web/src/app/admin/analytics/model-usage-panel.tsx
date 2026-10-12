"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  modelUsageAnalyticsResponseSchema,
  type ModelUsageAnalyticsResponse,
} from "@knowflow/shared";

import {
  ChartFrame,
  AXIS_LINE_STYLE,
  AXIS_TICK_STYLE,
  chartColor,
  GRID_STYLE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "../../../components/ui/charts";
import { EmptyState, Skeleton } from "../../../components/ui/feedback";
import { MetricCard } from "../../../components/ui/metric-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../../components/ui/table";
import { apiRequest } from "../../../lib/api";

type UsageRange = "today" | "7d" | "30d";

// 展示超级管理员可见的模型调用量、Token、标准价估算成本与每日趋势。
export function ModelUsagePanel({ range }: { range: UsageRange }) {
  const [data, setData] = useState<ModelUsageAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 时间范围变化时重新读取汇总接口，并在切换时取消过期请求。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void apiRequest(`/analytics/model-usage?range=${range}`, modelUsageAnalyticsResponseSchema, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((result) => setData(result))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "模型用量加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range]);

  const chartData = useMemo(() => {
    if (data === null) return [];
    const byDate = new Map<string, Record<string, string | number>>();
    for (const row of data.daily) {
      const point = byDate.get(row.date) ?? { 日期: row.date.slice(5) };
      point[row.model] = row.estimatedCostCny ?? 0;
      byDate.set(row.date, point);
    }
    return [...byDate.values()];
  }, [data]);

  if (loading) {
    return (
      <section className="space-y-4" aria-label="模型用量">
        <h2 className="text-base font-semibold text-ink">模型用量与成本估算</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </section>
    );
  }

  if (error !== null || data === null) {
    return (
      <section aria-label="模型用量">
        <h2 className="mb-3 text-base font-semibold text-ink">模型用量与成本估算</h2>
        <p className="rounded-md bg-danger-bg px-4 py-3 text-sm text-danger" role="alert">
          {error ?? "模型用量暂不可用。"}
        </p>
      </section>
    );
  }

  const modelKeys = data.byModel.map((row) => row.model);

  return (
    <section className="space-y-4" aria-label="模型用量">
      <div>
        <h2 className="text-base font-semibold text-ink">模型用量与成本估算</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          仅含 Agent
          对话中的模型、嵌入与重排调用；成本按北京标准价估算，不含折扣、免费额度和后台任务。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="模型调用" value={data.totals.requestCount.toLocaleString()} />
        <MetricCard label="输入 Token" value={data.totals.inputTokens.toLocaleString()} />
        <MetricCard label="输出 Token" value={data.totals.outputTokens.toLocaleString()} />
        <MetricCard
          label="估算成本"
          value={
            data.totals.estimatedCostCny === null
              ? "成本估算不完整"
              : `¥${data.totals.estimatedCostCny.toFixed(4)}`
          }
        />
      </div>

      {data.totals.unknownUsageCount > 0 ? (
        <p className="rounded-md bg-warning-bg px-3 py-2 text-xs text-warning" role="status">
          有 {data.totals.unknownUsageCount}{" "}
          次调用的用量或标准价估算不完整，这些调用不计入成本估算。
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartFrame title="每日标准价估算（人民币）" height={270}>
          {chartData.length === 0 ? (
            <EmptyState
              title="暂无模型调用"
              description="所选时间范围内没有 Agent 对话模型用量。"
            />
          ) : (
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" {...GRID_STYLE} vertical={false} />
                <XAxis
                  dataKey="日期"
                  tick={AXIS_TICK_STYLE}
                  axisLine={AXIS_LINE_STYLE}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_TICK_STYLE}
                  axisLine={false}
                  tickLine={false}
                  width={58}
                  tickFormatter={(value: number) => `¥${value.toFixed(3)}`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  formatter={(value) => [`¥${Number(value ?? 0).toFixed(6)}`, "估算成本"]}
                />
                {modelKeys.map((model, index) => (
                  <Bar
                    key={model}
                    dataKey={model}
                    name={model}
                    stackId="cost"
                    fill={chartColor(index)}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartFrame>

        <div className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">按模型汇总</h3>
          </div>
          {data.byModel.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">暂无数据</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>模型</TableHeaderCell>
                  <TableHeaderCell>调用</TableHeaderCell>
                  <TableHeaderCell>输入 / 输出 Token</TableHeaderCell>
                  <TableHeaderCell>估算成本</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byModel.map((row) => (
                  <TableRow key={row.model}>
                    <TableCell className="font-medium">{row.model}</TableCell>
                    <TableCell>{row.requestCount.toLocaleString()}</TableCell>
                    <TableCell className="text-ink-muted">
                      {row.inputTokens.toLocaleString()} / {row.outputTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {row.estimatedCostCny === null
                        ? "未知"
                        : `¥${row.estimatedCostCny.toFixed(6)}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </section>
  );
}
