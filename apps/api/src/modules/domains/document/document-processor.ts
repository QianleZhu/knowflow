// 文档处理流水线编排、状态迁移和片段持久化。
import { db, documents, files, knowledgeBases, parentChunks, childChunks } from "@knowflow/db";
import type { DocumentSourceType } from "@knowflow/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createAliyunLlmClient,
  EXPECTED_EMBEDDING_DIMENSION,
} from "../../../shared/llm/aliyun-llm.js";
import { resolveLocalStorageRoot } from "../../../shared/storage/local-storage.js";
import { createImprovementQueue } from "../knowledge-base/knowledge-improvement-queue.js";
import type { DocumentProcessResult } from "./document-queue.js";
import { publishDocumentProgress } from "./document-progress.js";
import { CHUNKER_VERSION, splitParentChunks, splitChildChunks } from "./document-chunker.js";
import type { ParsedDocument } from "./parsers/types.js";
import { parseDocumentBuffer } from "./parsers/registry.js";

const EMBEDDING_BATCH_SIZE = 10;

const DOCUMENT_PROCESS_VERSION_KEY = "__processVersion";

type ProcessableDocument = {
  id: string;
  knowledgeBaseId: string;
  sourceType: DocumentSourceType;
  sourceUri: string | null;
  fileId: string | null;
  fileType: string | null;
  title: string;
  embeddingModel: string;
  metadata: unknown;
};

type ProcessJobKey = {
  documentId: string;
  processVersion: number | null;
};

// 编排解析、切分与向量化流水线，并保留原有版本锁和失败处理。
export async function processDocument(documentJobId: string): Promise<DocumentProcessResult> {
  const jobKey = decodeProcessJobDocumentId(documentJobId);
  try {
    const document = await findProcessableDocument(jobKey.documentId);
    if (document === undefined) {
      throw new Error(`未找到文档: ${jobKey.documentId}`);
    }
    const currentProcessVersion = readProcessVersion(document.metadata);
    // 过期任务不覆盖新版本解析结果，重复领取仍由数据库状态条件拦截。
    if (jobKey.processVersion !== null && currentProcessVersion !== jobKey.processVersion) {
      return {
        documentId: jobKey.documentId,
        status: "completed",
      };
    }
    const processVersion = jobKey.processVersion ?? currentProcessVersion;
    const claimed = await markParsing(document.id, processVersion);
    if (!claimed) {
      return {
        documentId: document.id,
        status: "completed",
      };
    }

    await publishProgress(document.id, "parsing", 15, "正在解析文档文本");
    const parsed = await parseDocument(document);
    await markParsed(document.id, parsed, processVersion);
    await markChunking(document.id, processVersion);
    await publishProgress(document.id, "chunking", 35, "正在切分文档内容");
    await replaceChunks(document, parsed, processVersion);
    await markChunked(document.id, processVersion);
    await publishProgress(document.id, "embedding", 60, "正在向量化文档片段");
    await embedChildChunks(document, processVersion);
    await markCompleted(document.id, processVersion);
    await enqueueDocumentExtractionAfterCompletion(document.id, parsed.metadata.parsedAt);
    await publishProgress(document.id, "completed", 100, "文档处理已完成");

    return {
      documentId: document.id,
      status: "completed",
    };
  } catch (error) {
    await markFailed(jobKey.documentId, error, jobKey.processVersion);
    await publishProgress(
      jobKey.documentId,
      "failed",
      100,
      error instanceof Error ? error.message : "文档处理失败",
    );
    return {
      documentId: jobKey.documentId,
      status: "failed",
    };
  }
}

// 文档处理成功后尝试入队知识抽取，入队失败不影响处理结果。
async function enqueueDocumentExtractionAfterCompletion(
  documentId: string,
  parsedAt: string,
): Promise<void> {
  try {
    await enqueueDocumentExtraction(documentId, parsedAt);
  } catch (error) {
    console.warn(`文档 ${documentId} 已完成处理，但知识抽取任务入队失败`, error);
  }
}

// 创建知识抽取任务并释放队列连接。
async function enqueueDocumentExtraction(documentId: string, parsedAt: string): Promise<void> {
  const queue = createImprovementQueue();
  try {
    await queue.add(
      "document_extraction",
      { documentId },
      {
        jobId: `document-extraction-${documentId}-${parsedAt.replace(/[^0-9A-Za-z_-]/g, "")}`,
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    );
  } finally {
    await queue.close();
  }
}

// 发布当前文档处理阶段与进度。
async function publishProgress(
  documentId: string,
  stage: "pending" | "parsing" | "chunking" | "embedding" | "completed" | "failed",
  percent: number,
  message: string,
): Promise<void> {
  await publishDocumentProgress({
    documentId,
    stage,
    percent,
    message,
  });
}

// 查询文档及其有效知识库的处理配置。
async function findProcessableDocument(
  documentId: string,
): Promise<ProcessableDocument | undefined> {
  const [document] = await db
    .select({
      id: documents.id,
      knowledgeBaseId: documents.knowledgeBaseId,
      sourceType: documents.sourceType,
      sourceUri: documents.sourceUri,
      fileId: documents.fileId,
      fileType: documents.fileType,
      title: documents.title,
      embeddingModel: knowledgeBases.embeddingModel,
      metadata: documents.metadata,
    })
    .from(documents)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, documents.knowledgeBaseId))
    .where(and(eq(documents.id, documentId), isNull(knowledgeBases.deletedAt)))
    .limit(1);

  return document;
}

// 通过处理版本与状态条件领取解析任务。
async function markParsing(documentId: string, processVersion: number): Promise<boolean> {
  const rows = await db
    .update(documents)
    .set({
      processStatus: "parsing",
      parseStatus: "parsing",
      chunkStatus: "pending",
      embeddingStatus: "pending",
      errorMessage: null,
      metadata: sql`${documents.metadata} - 'failedStage'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documents.id, documentId),
        inArray(documents.processStatus, ["pending", "failed"]),
        processVersionCondition(processVersion),
      ),
    )
    .returning({ id: documents.id });
  return rows.length > 0;
}

// 记录解析元数据并推进到切分阶段。
async function markParsed(
  documentId: string,
  parsed: ParsedDocument,
  processVersion: number,
): Promise<void> {
  await ensureUpdated(
    db
      .update(documents)
      .set({
        processStatus: "chunking",
        parseStatus: "completed",
        metadata: sql`${documents.metadata} || ${JSON.stringify(parsed.metadata)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), processVersionCondition(processVersion)))
      .returning({ id: documents.id }),
  );
}

// 标记切分正在执行。
async function markChunking(documentId: string, processVersion: number): Promise<void> {
  await ensureUpdated(
    db
      .update(documents)
      .set({
        processStatus: "chunking",
        chunkStatus: "chunking",
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), processVersionCondition(processVersion)))
      .returning({ id: documents.id }),
  );
}

// 切分完成后进入向量化阶段。
async function markChunked(documentId: string, processVersion: number): Promise<void> {
  await ensureUpdated(
    db
      .update(documents)
      .set({
        processStatus: "embedding",
        chunkStatus: "completed",
        embeddingStatus: "embedding",
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), processVersionCondition(processVersion)))
      .returning({ id: documents.id }),
  );
}

// 标记当前处理版本完成。
async function markCompleted(documentId: string, processVersion: number): Promise<void> {
  await ensureUpdated(
    db
      .update(documents)
      .set({
        processStatus: "completed",
        embeddingStatus: "completed",
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), processVersionCondition(processVersion)))
      .returning({ id: documents.id }),
  );
}

// 只标记执行中的阶段失败，保留已完成结果。
async function markFailed(
  documentId: string,
  error: unknown,
  processVersion: number | null,
): Promise<void> {
  const condition =
    processVersion === null
      ? eq(documents.id, documentId)
      : and(eq(documents.id, documentId), processVersionCondition(processVersion));
  await db
    .update(documents)
    .set({
      processStatus: "failed",
      parseStatus: sql`case when ${documents.parseStatus} = 'parsing' then 'failed'::process_status else ${documents.parseStatus} end`,
      chunkStatus: sql`case when ${documents.chunkStatus} = 'chunking' then 'failed'::process_status else ${documents.chunkStatus} end`,
      embeddingStatus: sql`case when ${documents.embeddingStatus} = 'embedding' then 'failed'::embedding_status else ${documents.embeddingStatus} end`,
      metadata: sql`${documents.metadata} || jsonb_build_object('failedStage', ${documents.processStatus})`,
      errorMessage: error instanceof Error ? error.message : "文档处理失败",
      updatedAt: new Date(),
    })
    .where(condition);
}

// 在事务中替换父子片段并记录页码、标题和版本。
async function replaceChunks(
  document: ProcessableDocument,
  parsed: ParsedDocument,
  processVersion: number,
): Promise<void> {
  const parents = splitParentChunks(parsed.text);
  // 父子片段必须一起替换，任一插入失败时回滚整个事务。
  await db.transaction(async (tx) => {
    const [currentDocument] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, document.id), processVersionCondition(processVersion)))
      .limit(1);
    if (currentDocument === undefined) {
      throw new Error("文档处理版本已过期");
    }

    await tx.delete(childChunks).where(eq(childChunks.documentId, document.id));
    await tx.delete(parentChunks).where(eq(parentChunks.documentId, document.id));

    let nextChildIndex = 0;
    for (const parent of parents) {
      const [createdParent] = await tx
        .insert(parentChunks)
        .values({
          documentId: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          title: parent.title,
          content: parent.content,
          headingPath: parent.headingPath,
          pageStart: parent.pageStart,
          pageEnd: parent.pageEnd,
          metadata: {
            chunkerVersion: CHUNKER_VERSION,
            boundaryType: parent.boundaryType,
            processVersion,
          },
        })
        .returning({ id: parentChunks.id });
      if (createdParent === undefined) {
        throw new Error("创建文档父片段失败");
      }

      const children = splitChildChunks(parent.content);
      if (children.length === 0) {
        throw new Error("文档切分未生成子片段");
      }

      await tx.insert(childChunks).values(
        children.map((child) => ({
          parentChunkId: createdParent.id,
          documentId: document.id,
          knowledgeBaseId: document.knowledgeBaseId,
          content: child.content,
          chunkIndex: nextChildIndex++,
          tokenCount: child.tokenCount,
          metadata: {
            parentTitle: parent.title,
            headingPath: parent.headingPath,
            chunkerVersion: CHUNKER_VERSION,
            boundaryType: child.boundaryType,
            processVersion,
            pageStart: parent.pageStart,
            pageEnd: parent.pageEnd,
          },
          embeddingStatus: "pending" as const,
        })),
      );
    }
  });
}

// 分批生成向量并校验数量和维度后写入数据库。
async function embedChildChunks(
  document: ProcessableDocument,
  processVersion: number,
): Promise<void> {
  const [currentDocument] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, document.id), processVersionCondition(processVersion)))
    .limit(1);
  if (currentDocument === undefined) {
    throw new Error("文档处理版本已过期");
  }

  const chunks = await db
    .select({
      id: childChunks.id,
      content: childChunks.content,
    })
    .from(childChunks)
    .where(eq(childChunks.documentId, document.id))
    .orderBy(asc(childChunks.chunkIndex));
  if (chunks.length === 0) {
    throw new Error("文档没有可向量化的子片段");
  }

  const client = createAliyunLlmClient();
  for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
    const embeddings = await client.embedTexts(
      batch.map((chunk) => chunk.content),
      document.embeddingModel,
    );
    if (embeddings.length !== batch.length) {
      throw new Error("向量化返回数量与输入片段数量不一致");
    }

    await db.transaction(async (tx) => {
      for (let index = 0; index < batch.length; index += 1) {
        const chunk = batch[index];
        const embedding = embeddings[index];
        if (chunk === undefined || embedding === undefined) {
          throw new Error("向量化返回内容不完整");
        }
        // 入库前确认向量维度，避免损坏后续检索使用的数据。
        if (embedding.length !== EXPECTED_EMBEDDING_DIMENSION) {
          throw new Error(`向量维度不匹配：${String(embedding.length)}`);
        }

        await tx
          .update(childChunks)
          .set({
            embedding,
            searchVector: sql`to_tsvector('simple', ${chunk.content})`,
            embeddingStatus: "completed",
            updatedAt: new Date(),
          })
          .where(eq(childChunks.id, chunk.id));
      }
    });
  }
}

// 解析任务标识中的文档编号与处理版本。
function decodeProcessJobDocumentId(documentJobId: string): ProcessJobKey {
  const separatorIndex = documentJobId.lastIndexOf(DOCUMENT_PROCESS_VERSION_KEY);
  if (separatorIndex < 0) {
    return { documentId: documentJobId, processVersion: null };
  }
  const documentId = documentJobId.slice(0, separatorIndex);
  const versionText = documentJobId.slice(separatorIndex + DOCUMENT_PROCESS_VERSION_KEY.length);
  const processVersion = Number.parseInt(versionText, 10);
  if (documentId.length === 0 || !Number.isInteger(processVersion) || processVersion <= 0) {
    return { documentId: documentJobId, processVersion: null };
  }
  return { documentId, processVersion };
}

// 读取文档元数据中的处理版本。
function readProcessVersion(metadata: unknown): number {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return 0;
  }
  const value = (metadata as Record<string, unknown>)["processVersion"];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

// 构造处理版本的乐观锁条件。
function processVersionCondition(processVersion: number) {
  return sql`coalesce((${documents.metadata}->>'processVersion')::integer, 0) = ${processVersion}`;
}

// 确认状态迁移生效，拒绝过期处理版本。
async function ensureUpdated(update: Promise<{ id: string }[]>): Promise<void> {
  const rows = await update;
  if (rows.length === 0) {
    throw new Error("文档处理版本已过期");
  }
}

// 查询文件位置并阻止路径越过本地存储根目录。
async function resolveDocumentPath(document: ProcessableDocument): Promise<string> {
  if (document.fileId === null) {
    throw new Error("文档文件缺失");
  }

  const [file] = await db
    .select({ storagePath: files.storagePath })
    .from(files)
    .where(eq(files.id, document.fileId))
    .limit(1);
  if (file === undefined) {
    throw new Error("文档文件元数据缺失");
  }

  const storageRoot = resolveLocalStorageRoot();
  const absolutePath = path.resolve(storageRoot, file.storagePath);
  const relativePath = path.relative(storageRoot, absolutePath);
  // 文件路径仍由持久化层校验，解析器没有任意读取本地文件的能力。
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("文档存储路径无效");
  }

  return absolutePath;
}

// 从受保护的存储路径加载文件，将格式选择交给解析器注册表。
async function parseDocument(document: ProcessableDocument): Promise<ParsedDocument> {
  const buffer = await readFile(await resolveDocumentPath(document));
  return parseDocumentBuffer(buffer, {
    sourceType: document.sourceType,
    mimeType: document.fileType,
    documentId: document.id,
    title: document.title,
  });
}
