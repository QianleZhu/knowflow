// 本脚本用真实 Jev 与生产路由后处理评测固定标注集，独立记录分类错误和调用失败。
import "reflect-metadata";
import "../shared/config/load-env.js";

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  JevIntentService,
  QUERY_INTENTS,
  type JevIntentClassification,
  type JevIntentRequest,
  type QueryIntent,
} from "../modules/domains/agent/jev-intent.service.js";
import {
  QueryUnderstandingService,
  type QueryPlan,
} from "../modules/domains/agent/query-understanding.service.js";

const CaseSchema = z.object({
  id: z.string().min(1),
  suite: z.enum(["legacy", "single", "mixed", "context", "diagnostic"]),
  query: z.string().min(1),
  recentMessages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
  conversationSummary: z.string().nullable(),
  expectedIntents: z.array(z.enum(QUERY_INTENTS)).min(1).nullable(),
  note: z.string(),
});
const DatasetSchema = z.object({
  version: z.string(),
  annotationPolicy: z.array(z.string()),
  cases: z.array(CaseSchema).min(1),
});
type EvalCase = z.infer<typeof CaseSchema>;
type EvalResult = {
  input: EvalCase;
  plan: QueryPlan;
  classification: JevIntentClassification | null;
  infrastructureError: string | null;
  exactMatch: boolean | null;
  elapsedMs: number;
};
type Counts = { tp: number; fp: number; fn: number };

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evaluationRoot = path.join(repositoryRoot, "evals/jev-intents");

// 仅观察生产调用结果，仍由原有服务完成真实模型请求，不替换任何分类逻辑。
class ObservedJevService extends JevIntentService {
  classification: JevIntentClassification | null = null;
  infrastructureError: string | null = null;

  // 捕获成功响应和异常，防止 QueryUnderstanding 的安全降级被评测器当成成功分类。
  override async classify(
    input: JevIntentRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<JevIntentClassification> {
    try {
      this.classification = await super.classify(input, options);
      return this.classification;
    } catch (error) {
      this.infrastructureError = safeError(error);
      throw error;
    }
  }
}

// 仅保存脱敏的错误消息，禁止输出 SDK 错误对象中可能附带的认证请求头。
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知调用错误";
  const key = process.env["OPENROUTER_API_KEY"]?.trim();
  return (key ? message.replaceAll(key, "[REDACTED]") : message).slice(0, 1500);
}

// 从参数读取正整数，并限制并发避免评测无限放大模型调用成本。
function integerArgument(name: string, fallback: number, maximum: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${String(maximum)} 之间的整数`);
  }
  return value;
}

// 校验标签唯一性和诊断题边界，禁止在模型结果出来后自动推导或补填真值。
function validateCases(cases: EvalCase[]): void {
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("题目 ID 重复");
  for (const item of cases) {
    const expected = item.expectedIntents;
    if ((item.suite === "diagnostic") !== (expected === null)) {
      throw new Error(`${item.id} 的诊断标记与预期标签不一致`);
    }
    if (
      expected !== null &&
      (new Set(expected).size !== expected.length ||
        (expected.includes("unclear") && expected.length > 1))
    ) {
      throw new Error(`${item.id} 的标签重复或把 unclear 与确定意图混用`);
    }
  }
}

// 顺序不影响多标签真值；只有集合完全相同时才计入整组正确。
function sameIntents(actual: QueryIntent[], expected: QueryIntent[]): boolean {
  return actual.length === expected.length && expected.every((intent) => actual.includes(intent));
}

// 每道题仅调用一次真实 Jev，并通过生产 understand 函数应用阈值和路由逻辑。
async function evaluateCase(input: EvalCase): Promise<EvalResult> {
  const started = Date.now();
  const jev = new ObservedJevService();
  const plan = await new QueryUnderstandingService(jev).understand({
    query: input.query,
    recentMessages: input.recentMessages,
    conversationSummary: input.conversationSummary,
    accessibleKnowledgeBases: [],
  });
  const infrastructureError =
    jev.infrastructureError ?? (plan.trace.source === "degraded" ? "生产服务返回降级分类" : null);
  return {
    input,
    plan,
    classification: jev.classification,
    infrastructureError,
    exactMatch:
      input.expectedIntents === null || infrastructureError !== null
        ? null
        : sameIntents(plan.intents, input.expectedIntents),
    elapsedMs: Date.now() - started,
  };
}

// 累计独立标签的真假阳性与假阴性，不把非命中类别的真阴性稀释进准确率。
function countPrediction(counts: Counts, expected: boolean, actual: boolean): void {
  if (expected && actual) counts.tp += 1;
  else if (!expected && actual) counts.fp += 1;
  else if (expected && !actual) counts.fn += 1;
}

// 无预测或无正例时对应比率为 null，避免零分母被误写成 100%。
function metrics(counts: Counts) {
  const precision = counts.tp + counts.fp === 0 ? null : counts.tp / (counts.tp + counts.fp);
  const recall = counts.tp + counts.fn === 0 ? null : counts.tp / (counts.tp + counts.fn);
  const denominator = 2 * counts.tp + counts.fp + counts.fn;
  return {
    ...counts,
    precision,
    recall,
    f1: denominator === 0 ? null : (2 * counts.tp) / denominator,
  };
}

// 在真实响应题上计算分类质量，另报告全部计划题的调用成功率和执行覆盖率。
function summarize(results: EvalResult[], planned: number) {
  const scored = results.filter((item) => item.input.expectedIntents !== null);
  const successful = scored.filter((item) => item.infrastructureError === null);
  const perIntent = Object.fromEntries(
    QUERY_INTENTS.map((intent) => [intent, { tp: 0, fp: 0, fn: 0 }]),
  ) as Record<QueryIntent, Counts>;
  const mixed: Counts = { tp: 0, fp: 0, fn: 0 };
  let correctRetrievalDecisions = 0;
  for (const item of successful) {
    const expected = item.input.expectedIntents;
    if (expected === null) continue;
    for (const intent of QUERY_INTENTS)
      countPrediction(
        perIntent[intent],
        expected.includes(intent),
        item.plan.intents.includes(intent),
      );
    countPrediction(mixed, expected.length > 1, item.plan.isMixed);
    if (
      item.plan.needsRetrieval ===
      (expected.includes("knowledge_qa") || expected.includes("unclear"))
    ) {
      correctRetrievalDecisions += 1;
    }
  }
  const intentMetrics = QUERY_INTENTS.map((intent) => ({
    intent,
    support: perIntent[intent].tp + perIntent[intent].fn,
    ...metrics(perIntent[intent]),
  }));
  const micro = metrics(
    Object.values(perIntent).reduce(
      (sum, counts) => ({
        tp: sum.tp + counts.tp,
        fp: sum.fp + counts.fp,
        fn: sum.fn + counts.fn,
      }),
      { tp: 0, fp: 0, fn: 0 },
    ),
  );
  const f1Values = intentMetrics.flatMap((item) => (item.f1 === null ? [] : [item.f1]));
  const latencies = results
    .filter((item) => item.infrastructureError === null)
    .map((item) => item.elapsedMs)
    .sort((a, b) => a - b);
  return {
    planned,
    attempted: results.length,
    successfulCalls: results.filter((item) => item.infrastructureError === null).length,
    infrastructureFailures: results.filter((item) => item.infrastructureError !== null).length,
    scoredAttempts: scored.length,
    scoredSuccessful: successful.length,
    exactMatches: successful.filter((item) => item.exactMatch === true).length,
    exactMatchRate:
      successful.length === 0
        ? null
        : successful.filter((item) => item.exactMatch === true).length / successful.length,
    perIntent: intentMetrics,
    micro,
    macroF1: f1Values.length === 0 ? null : f1Values.reduce((a, b) => a + b, 0) / f1Values.length,
    mixed: metrics(mixed),
    correctRetrievalDecisions,
    retrievalDecisionAccuracy:
      successful.length === 0 ? null : correctRetrievalDecisions / successful.length,
    meanLatencyMs:
      latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null,
    tokens: results.reduce(
      (sum, item) => ({
        input: sum.input + (item.classification?.usage.input_tokens ?? 0),
        output: sum.output + (item.classification?.usage.output_tokens ?? 0),
      }),
      { input: 0, output: 0 },
    ),
    suites: [...new Set(results.map((item) => item.input.suite))].map((suite) => {
      const items = successful.filter((item) => item.input.suite === suite);
      return {
        suite,
        scoredSuccessful: items.length,
        exactMatches: items.filter((item) => item.exactMatch === true).length,
      };
    }),
  };
}

// 将概率与指标格式化为便于审阅的百分比；未定义值明确显示为空。
function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

// 防止输入中的竖线或换行破坏 Markdown 报告表格。
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

// 生成可逐题复查的分类报告，诊断题和基础设施失败均不混入准确率。
function renderReport(
  summary: ReturnType<typeof summarize>,
  results: EvalResult[],
  version: string,
): string {
  const mismatches = results.filter((item) => item.exactMatch === false);
  const diagnostics = results.filter((item) => item.input.expectedIntents === null);
  return [
    "# Jev 多意图真实模型评测",
    "",
    `数据集：${version}。实际尝试 ${String(summary.attempted)}/${String(summary.planned)} 题，成功调用 ${String(summary.successfulCalls)} 题，基础设施失败 ${String(summary.infrastructureFailures)} 题。`,
    `标注题成功响应 ${String(summary.scoredSuccessful)} 题，整组标签正确 ${String(summary.exactMatches)} 题（${percent(summary.exactMatchRate)}）。诊断题不计入分类指标。`,
    "",
    `Micro-F1：${percent(summary.micro.f1)}；Macro-F1：${percent(summary.macroF1)}；混合识别 Precision/Recall/F1：${percent(summary.mixed.precision)} / ${percent(summary.mixed.recall)} / ${percent(summary.mixed.f1)}。`,
    `检索决策正确率：${percent(summary.retrievalDecisionAccuracy)}；平均/P95 耗时：${summary.meanLatencyMs?.toFixed(0) ?? "—"} / ${String(summary.p95LatencyMs ?? "—")} ms；Token 用量：${String(summary.tokens.input)} 输入，${String(summary.tokens.output)} 输出。`,
    "",
    "| 意图 | 正例数 | Precision | Recall | F1 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...summary.perIntent.map(
      (item) =>
        `| ${item.intent} | ${String(item.support)} | ${percent(item.precision)} | ${percent(item.recall)} | ${percent(item.f1)} |`,
    ),
    "",
    "## 标签不匹配",
    "",
    "| ID | 问题 | 预期 | 实际 |",
    "| --- | --- | --- | --- |",
    ...mismatches.map(
      (item) =>
        `| ${item.input.id} | ${cell(item.input.query)} | ${item.input.expectedIntents?.join(", ") ?? "—"} | ${item.plan.intents.join(", ")} |`,
    ),
    "",
    "## 分类边界诊断（不评分）",
    "",
    "| ID | 问题 | 实际 | 说明 |",
    "| --- | --- | --- | --- |",
    ...diagnostics.map(
      (item) =>
        `| ${item.input.id} | ${cell(item.input.query)} | ${item.infrastructureError === null ? item.plan.intents.join(", ") : "调用失败"} | ${cell(item.input.note)} |`,
    ),
    "",
    "## 基础设施失败",
    "",
    ...results
      .filter((item) => item.infrastructureError !== null)
      .map((item) => `- ${item.input.id}: ${cell(item.infrastructureError ?? "")}`),
    "",
    "本轮仅验证真实 Jev 分类与生产阈值/检索决策后处理。未验证子任务拆分、数据库权限查询、检索召回或最终回答质量。报告为固定人工标注的离线回归基线，不代表生产分布准确率。",
    "",
  ].join("\n");
}

// 固定数据与源码哈希，保证后续能判断两次评测是否使用相同题目和分类逻辑。
async function sourceHash(relativePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path.join(repositoryRoot, relativePath)))
    .digest("hex");
}

// 校验后先按受限并发调用模型，再保存完整配置与结果，连续故障时停止剩余请求。
async function run(): Promise<void> {
  const dataset = DatasetSchema.parse(
    JSON.parse(await readFile(path.join(evaluationRoot, "dataset.json"), "utf8")),
  );
  validateCases(dataset.cases);
  const idsIndex = process.argv.indexOf("--ids");
  const ids = idsIndex === -1 ? null : process.argv[idsIndex + 1]?.split(",");
  if (
    idsIndex !== -1 &&
    (!ids || ids.length === 0 || ids.some((id) => !dataset.cases.some((item) => item.id === id)))
  ) {
    throw new Error("--ids 必须指定数据集中的题目 ID");
  }
  const selected = dataset.cases.filter((item) => ids === null || ids?.includes(item.id));
  const cases = selected.slice(
    0,
    integerArgument("--limit", selected.length, dataset.cases.length),
  );
  const concurrency = integerArgument("--concurrency", 2, 4);
  const configuredThreshold = process.env["JEV_INTENT_THRESHOLD"]?.trim();
  const threshold = configuredThreshold ? Number(configuredThreshold) : 0.5;
  const configuredModel = process.env["JEV_INTENT_MODEL"]?.trim() ?? "";
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("意图阈值不合法");
  const configuration = {
    createdAt: new Date().toISOString(),
    datasetVersion: dataset.version,
    model: configuredModel.length > 0 ? configuredModel : "jev-1.13",
    threshold,
    concurrency,
    endpoint: "https://openrouter.ai/api/v1/systemone",
    retries: 0,
    hashes: {
      dataset: await sourceHash("evals/jev-intents/dataset.json"),
      jev: await sourceHash("apps/api/src/modules/domains/agent/jev-intent.service.ts"),
      routing: await sourceHash(
        "apps/api/src/modules/domains/agent/query-understanding.service.ts",
      ),
      evaluator: await sourceHash("apps/api/src/scripts/jev-intent-eval.ts"),
    },
  };
  if (process.argv.includes("--dry-run")) {
    console.log(
      JSON.stringify({ ...configuration, selectedCases: cases.length, liveCalls: 0 }, null, 2),
    );
    return;
  }
  if (!process.env["OPENROUTER_API_KEY"]?.trim()) throw new Error("OPENROUTER_API_KEY 未配置");
  const directory = path.join(
    evaluationRoot,
    "results",
    configuration.createdAt.replaceAll(/[:.]/g, "-") +
      (cases.length === dataset.cases.length ? "-full" : "-smoke"),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "configuration.json"),
    JSON.stringify(configuration, null, 2) + "\n",
  );
  const results: EvalResult[] = [];
  let cursor = 0;
  let consecutiveFailures = 0;
  let journal = Promise.resolve();
  // 按独立请求受限并发，不启动多个开发 Agent，也不改动生产数据。
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < cases.length && consecutiveFailures < 3) {
        const input = cases[cursor++];
        if (!input) break;
        const result = await evaluateCase(input);
        results.push(result);
        consecutiveFailures = result.infrastructureError === null ? 0 : consecutiveFailures + 1;
        // 每题立即落盘，进程中断时仍可审计已经完成的真实调用。
        journal = journal.then(() =>
          appendFile(path.join(directory, "results.jsonl"), JSON.stringify(result) + "\n"),
        );
        await journal;
        if (results.length % 10 === 0 || result.infrastructureError !== null) {
          console.log(
            JSON.stringify({
              completed: results.length,
              total: cases.length,
              id: input.id,
              error: result.infrastructureError,
              exactMatch: result.exactMatch,
            }),
          );
        }
      }
    }),
  );
  results.sort((a, b) => cases.indexOf(a.input) - cases.indexOf(b.input));
  const summary = summarize(results, cases.length);
  await writeFile(path.join(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify({ ...configuration, ...summary }, null, 2) + "\n",
  );
  await writeFile(
    path.join(directory, "report.md"),
    renderReport(summary, results, dataset.version),
  );
  console.log(JSON.stringify({ directory, ...summary }, null, 2));
  if (summary.infrastructureFailures > 0 || results.length !== cases.length) process.exitCode = 1;
}

// 入口错误只输出脱敏文本，不展开可能包含环境凭据的异常对象。
run().catch((error: unknown) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
