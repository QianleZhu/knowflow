# Jev 多意图评测集 v2

本目录用于真实 Jev 分类与生产路由后处理评测。数据集包含 187 题：178 道固定标注题、9 道不评分的分类边界诊断题。每次评测直接调用生产 `JevIntentService` 和 `QueryUnderstandingService`，没有模型替身。

## 数据来源与标注

- 从旧评测 `evals/query-routing/results/2026-10-08T08-43-44-062Z-all-regression/rules.json` 恢复 116 道原题与会话上下文，按当前七类意图重新标注。旧 `expected.route` 仅作迁移线索，不作为当前模型结果的真值。
- 新增 31 道单意图/否定表达题、20 道混合题、12 道上下文/注入边界题、8 道诊断题。新混合题覆盖六种确定意图的全部 15 种两两组合及部分三意图组合。
- 旧题中“列出所有我不能访问的知识库”也改为诊断题，因此诊断题总计 9 道。
- 标签在模型调用前固定。问候/感谢与业务请求可分别标注；资料查询即使包含越权要求也标为知识问答，实际权限由后端决定。
- 明确的翻译、总结、改写任务标为 `conversation_transform`；仅有不明指代且没有上下文的请求标为 `unclear`。有明确转换任务但没有原文时，分类明确不等于执行素材齐全。
- 实时部门授权、文档故障、资源操作权限、不可访问资源枚举及未约定的实时事实/闲聊边界，暂不硬设当前分类真值。

`dataset.json` 的 `expectedIntents` 是一个意图集合；诊断题为 `null`。数据集属于回归基线，不是随机生产样本，也不是独立 holdout。标注存在产品边界判断，需结合误判样例审阅；调整标注或提示词时应另升数据版本并说明理由。

## 运行

在根目录 `.env` 配置 `OPENROUTER_API_KEY`。脚本沿用生产环境的 `JEV_INTENT_MODEL` 和 `JEV_INTENT_THRESHOLD`，默认模型 `jev-1.13`、阈值 `0.5`。Key 只用于认证，不写入结果或配置快照。

```powershell
# 仅校验数据与配置，不调用模型。
pnpm --filter @knowflow/api exec tsx src/scripts/jev-intent-eval.ts --dry-run

# 少量真实连通性检查；PowerShell 中逗号参数需要引号。
pnpm --filter @knowflow/api exec tsx src/scripts/jev-intent-eval.ts --ids 'c09,m01,s22' --concurrency 1

# 完整真实评测；默认并发为 2，允许范围 1～4。
pnpm --filter @knowflow/api exec tsx src/scripts/jev-intent-eval.ts --concurrency 2
```

也可用 `--limit 10` 限制题量。每次运行新建独立结果目录，不覆盖历史结果。Jev 失败后生产服务会安全降级，但评测记录捕获原始异常并将其列为基础设施失败，不计作正确的 `unclear` 预测；连续三次调用失败后停止派发新请求，已经进行的请求正常落盘。

## 指标与产物

- 整组标签完全匹配率：意图集合必须完全一致，忽略顺序。
- 每类 Precision/Recall/F1、Micro-F1 和 Macro-F1：按标签真假阳性/假阴性计算；无有效分母显示为空。
- 混合意图 Precision/Recall/F1、生产 `needsRetrieval` 决策正确率。
- 基础设施失败数量、实际调用覆盖量、成功响应的平均/P95 耗时与 Token 用量。
- `configuration.json`：模型、阈值、并发、接口与数据/生产分类源码/评测脚本哈希。
- `results.jsonl`：每题完成后追加，保证进程中断时仍保留已有调用证据。
- `results.json`：完整逐题输入、真值、实际标签、原始概率、响应模型、Token 用量与错误。
- `summary.json` 和 `report.md`：指标、逐题标签差异与不评分诊断。

分类质量指标只使用固定标注题的成功响应，报告同时列出调用失败与执行覆盖量。诊断题单独展示。推导“是否需要检索”的预期遵循当前产品规则：`knowledge_qa` 或 `unclear` 需要检索，其余标签不需要。

本评测不执行混合请求的 LLM 子任务拆分、不查业务数据库、不测检索召回或最终回答质量。它可以揭示分类和标签边界问题，不能证明完整 Agent 链路或权限行为正确。
