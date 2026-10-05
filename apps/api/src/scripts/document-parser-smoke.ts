// 新处理器的真实链路验证：独立创建测试文档，不与已有 Worker 竞争队列任务。
import "../shared/config/load-env.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import {
  db,
  closeDb,
  documents,
  files,
  users,
  knowledgeBases,
  parentChunks,
  childChunks,
} from "@knowflow/db";
import { eq, isNull } from "drizzle-orm";
import { processDocument } from "../modules/domains/document/document-processor.js";
import { resolveLocalStorageRoot } from "../shared/storage/local-storage.js";

// 使用真实数据库、文件存储与向量模型，验证解析元数据、片段和版本锁。
async function main(): Promise<void> {
  const documentId = randomUUID();
  const fileId = randomUUID();
  // 按显式参数验证不同格式，统一走真实处理器与向量写入链路。
  const sourceType = process.argv[2] ?? "txt";
  assert.ok(sourceType === "txt" || sourceType === "pdf" || sourceType === "docx");
  const expectedParser =
    sourceType === "pdf"
      ? "docling"
      : sourceType === "docx"
        ? "docling"
        : "plain-text";
  const mimeType =
    sourceType === "pdf"
      ? "application/pdf"
      : sourceType === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/plain";
  const storagePath = `parser-smoke-${documentId}.${sourceType}`;
  const storageRoot = resolveLocalStorageRoot();
  const absolutePath = path.join(storageRoot, storagePath);
  try {
    const [base] = await db
      .select()
      .from(knowledgeBases)
      .where(isNull(knowledgeBases.deletedAt))
      .limit(1);
    const [uploader] = await db.select({ id: users.id }).from(users).limit(1);
    assert.ok(base && uploader, "需要有效知识库和测试用户");
    const text = `# 解析拆分验证\n\n${documentId}\n\n第一段正文。\n\n## 子章节\n\n第二段正文。`;
    const buffer =
      sourceType === "txt"
        ? Buffer.from(text)
        : await readFile(
            new URL(
              `../modules/domains/document/parsers/fixtures/${sourceType === "pdf" ? "text.pdf" : "structured.docx"}`,
              import.meta.url,
            ),
          );
    await mkdir(storageRoot, { recursive: true });
    await writeFile(absolutePath, buffer);
    await db.insert(files).values({
      id: fileId,
      storagePath,
      filename: storagePath,
      fileType: mimeType,
      fileSize: buffer.length,
      hash: createHash("sha256").update(buffer).digest("hex"),
      uploaderId: uploader.id,
    });
    await db.insert(documents).values({
      id: documentId,
      knowledgeBaseId: base.id,
      title: "解析拆分验证",
      sourceType,
      fileId,
      fileType: mimeType,
      fileSize: buffer.length,
      uploaderId: uploader.id,
      metadata: { processVersion: 2 },
    });
    // 明确调用当前源码入口，验证不会依赖已启动 Worker 缓存的旧模块。
    assert.equal((await processDocument(`${documentId}__processVersion2`)).status, "completed");
    const [document] = await db.select().from(documents).where(eq(documents.id, documentId));
    assert.ok(document);
    assert.equal(document.processStatus, "completed", document.errorMessage ?? "处理未完成");
    assert.equal(document.parseStatus, "completed");
    assert.equal(document.chunkStatus, "completed");
    assert.equal(document.embeddingStatus, "completed");
    assert.equal((document.metadata as Record<string, unknown>)["parser"], expectedParser);
    assert.equal((document.metadata as Record<string, unknown>)["contentFormat"], "markdown");
    const parents = await db
      .select()
      .from(parentChunks)
      .where(eq(parentChunks.documentId, documentId));
    const children = await db
      .select()
      .from(childChunks)
      .where(eq(childChunks.documentId, documentId));
    assert.ok(parents.length >= 1);
    assert.ok(children.length >= 1);
    if (sourceType === "txt") {
      assert.equal(parents.length, 2);
      assert.ok(children.length >= 2);
    }
    assert.ok(
      children.every(
        (chunk) => chunk.embeddingStatus === "completed" && chunk.embedding?.length === 1024,
      ),
    );
    // 旧版本任务和重复任务均应跳过，已持久化正文保持不变。
    await processDocument(`${documentId}__processVersion1`);
    await processDocument(`${documentId}__processVersion2`);
    const after = await db.select().from(childChunks).where(eq(childChunks.documentId, documentId));
    assert.deepEqual(
      after.map((chunk) => chunk.id).sort(),
      children.map((chunk) => chunk.id).sort(),
    );
    console.log(
      JSON.stringify({
        processing: "completed",
        parser: expectedParser,
        parents: parents.length,
        children: children.length,
        embeddingDimension: 1024,
        staleAndRepeatedJobsSkipped: true,
      }),
    );
  } finally {
    // 仅清理本脚本生成的随机编号记录和单个文件，保留现有业务数据。
    await db.delete(childChunks).where(eq(childChunks.documentId, documentId));
    await db.delete(parentChunks).where(eq(parentChunks.documentId, documentId));
    await db.delete(documents).where(eq(documents.id, documentId));
    await db.delete(files).where(eq(files.id, fileId));
    await unlink(absolutePath).catch(() => undefined);
    await closeDb();
  }
}

await main();
