import { db, documents, parentChunks, childChunks } from "@knowflow/db";
import { documentProcessStatusSchema, type DocumentProgressEvent } from "@knowflow/shared";
import { eq, sql } from "drizzle-orm";
import Redis from "ioredis";

const PROGRESS_CHANNEL_PREFIX = "document:progress";

// 为每份文档生成独立的 Redis 通知频道。
export function getDocumentProgressChannel(documentId: string): string {
  return `${PROGRESS_CHANNEL_PREFIX}:${documentId}`;
}

// 从持久化状态构建快照，保证 SSE 和轮询使用相同字段及版本。
export async function loadDocumentProgressSnapshot(
  documentId: string,
): Promise<DocumentProgressEvent | undefined> {
  const [row] = await db
    .select({
      id: documents.id,
      stage: documents.processStatus,
      parseStatus: documents.parseStatus,
      chunkStatus: documents.chunkStatus,
      embeddingStatus: documents.embeddingStatus,
      error: documents.errorMessage,
      metadata: documents.metadata,
      updatedAt: documents.updatedAt,
      parentChunkCount: sql<number>`(select count(*)::int from ${parentChunks} where ${parentChunks.documentId} = ${documents.id})`,
      childChunkCount: sql<number>`(select count(*)::int from ${childChunks} where ${childChunks.documentId} = ${documents.id})`,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (row === undefined) return undefined;
  const metadata = row.metadata as Record<string, unknown>;
  const version = typeof metadata["processVersion"] === "number" ? metadata["processVersion"] : 1;
  const failedStage = documentProcessStatusSchema.safeParse(metadata["failedStage"]);
  const labels = {
    pending: "等待处理",
    parsing: "正在解析文档",
    chunking: "正在切分父块和子块",
    embedding: "正在向量化",
    completed: "文档处理完成",
    failed: "文档处理失败",
  };
  const percents = {
    pending: 5,
    parsing: 15,
    chunking: 35,
    embedding: 60,
    completed: 100,
    failed: 100,
  };
  return {
    documentId: row.id,
    stage: row.stage,
    percent: percents[row.stage],
    message: row.error ?? labels[row.stage],
    timestamp: new Date().toISOString(),
    processVersion: version,
    updatedAt: row.updatedAt.toISOString(),
    parseStatus: row.parseStatus,
    chunkStatus: row.chunkStatus,
    embeddingStatus: row.embeddingStatus,
    parentChunkCount: row.parentChunkCount,
    childChunkCount: row.childChunkCount,
    ...(failedStage.success ? { failedStage: failedStage.data } : {}),
  };
}

// 通知携带完整数据库快照，订阅者无需依赖分页列表推断子阶段。
export async function publishDocumentProgress(
  event: Omit<DocumentProgressEvent, "timestamp">,
): Promise<void> {
  const redis = createRedisClient();
  try {
    const snapshot = await loadDocumentProgressSnapshot(event.documentId);
    if (snapshot === undefined) return;
    const payload: DocumentProgressEvent = { ...snapshot, message: event.message };
    await redis.publish(getDocumentProgressChannel(event.documentId), JSON.stringify(payload));
  } finally {
    redis.disconnect();
  }
}

// 创建进度通知专用 Redis 客户端，与上传处理队列共享连接配置。
export function createRedisClient(): Redis {
  return new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
}
