import type { DocumentProgressEvent, KnowledgeDocument } from "@knowflow/shared";

const order = { pending: 0, parsing: 1, chunking: 2, embedding: 3, completed: 4, failed: 5 };

// 将上传响应或列表记录转换成与 SSE 相同的状态快照。
export function documentProgressSnapshot(document: KnowledgeDocument): DocumentProgressEvent {
  return {
    documentId: document.id,
    stage: document.processStatus,
    percent: document.processStatus === "completed" ? 100 : 0,
    message: document.errorMessage ?? "",
    timestamp: document.updatedAt,
    updatedAt: document.updatedAt,
    processVersion: document.processVersion ?? 1,
    parseStatus: document.parseStatus,
    chunkStatus: document.chunkStatus,
    embeddingStatus: document.embeddingStatus,
    parentChunkCount: document.parentChunkCount,
    childChunkCount: document.childChunkCount,
  };
}

// 拒绝旧处理版本和迟到快照，同一版本的阶段只能向前推进。
export function mergeDocumentProgress(
  current: DocumentProgressEvent | undefined,
  incoming: DocumentProgressEvent,
): DocumentProgressEvent {
  if (!current) return incoming;
  const oldVersion = current.processVersion ?? 1;
  const newVersion = incoming.processVersion ?? 1;
  if (newVersion < oldVersion) return current;
  if (newVersion > oldVersion) return incoming;
  const oldTime = Date.parse(current.updatedAt ?? current.timestamp);
  const newTime = Date.parse(incoming.updatedAt ?? incoming.timestamp);
  if (newTime < oldTime || order[incoming.stage] < order[current.stage]) return current;
  return { ...current, ...incoming };
}

// 判断是否需要继续订阅，处理失败和完成均为本轮终态。
export function isDocumentProcessing(stage: string): boolean {
  return ["pending", "parsing", "chunking", "embedding"].includes(stage);
}
