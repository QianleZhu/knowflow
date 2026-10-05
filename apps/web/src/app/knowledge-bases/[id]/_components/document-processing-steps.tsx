import type { DocumentProgressEvent, KnowledgeDocument } from "@knowflow/shared";

type StepState = "waiting" | "running" | "completed" | "failed";

// 将后端各阶段状态转换成步骤标记，保留失败前已完成的工作。
function stepState(status: string): StepState {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return status === "pending" ? "waiting" : "running";
}

// 列表和上传弹窗复用同一套处理步骤，阶段百分比只作为辅助信息。
export function DocumentProcessingSteps({
  document,
  progress,
}: {
  document: KnowledgeDocument;
  progress?: DocumentProgressEvent | undefined;
}) {
  const stage = progress?.stage ?? document.processStatus;
  const parents = progress?.parentChunkCount ?? document.parentChunkCount;
  const children = progress?.childChunkCount ?? document.childChunkCount;
  const chunkStatus = progress?.chunkStatus ?? document.chunkStatus;
  const steps: { label: string; state: StepState }[] = [
    { label: "上传成功", state: "completed" },
    { label: "文本解析", state: stepState(progress?.parseStatus ?? document.parseStatus) },
    {
      label:
        chunkStatus === "completed"
          ? `切分完成（父块 ${String(parents)} / 子块 ${String(children)}）`
          : "切分父块与子块",
      state: stepState(chunkStatus),
    },
    { label: "向量化", state: stepState(progress?.embeddingStatus ?? document.embeddingStatus) },
    {
      label: "处理完成",
      state: stage === "completed" ? "completed" : stage === "failed" ? "failed" : "waiting",
    },
  ];
  const symbols = { waiting: "○", running: "◉", completed: "✓", failed: "✕" };
  const tones = {
    waiting: "text-ink-subtle",
    running: "text-brand-700",
    completed: "text-success",
    failed: "text-danger",
  };
  return (
    <div className="mt-2 space-y-1" aria-live="polite">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {steps.map((step) => (
          <li key={step.label} className={tones[step.state]}>
            {symbols[step.state]} {step.label}
            {step.state === "running" ? "中" : ""}
          </li>
        ))}
      </ol>
      {stage === "pending" && <p className="text-xs text-ink-subtle">等待 Worker 处理</p>}
      {progress?.message && stage !== "failed" && (
        <p className="text-xs text-ink-subtle">{progress.message}</p>
      )}
      {stage === "failed" && (
        <p className="text-xs text-danger">
          {progress?.message ?? document.errorMessage ?? "文档处理失败"}
        </p>
      )}
    </div>
  );
}
