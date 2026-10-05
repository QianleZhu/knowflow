import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { describe, it } from "node:test";
import { documentUploadSchema, type DocumentUploadResult } from "@knowflow/shared";
import { UploadQueue, UploadRequestError, uploadRetryDelay } from "./upload-queue";
import { mergeDocumentProgress } from "./document-progress-state";

// 创建测试响应，使用真实共享 schema 校验契约。
function result(): DocumentUploadResult {
  const id = crypto.randomUUID();
  return documentUploadSchema.parse({
    id,
    knowledgeBaseId: crypto.randomUUID(),
    title: "测试",
    sourceType: "txt",
    sourceUri: null,
    fileId: null,
    fileType: "text/plain",
    fileSize: 4,
    uploaderId: crypto.randomUUID(),
    uploaderName: "测试用户",
    processStatus: "pending",
    parseStatus: "pending",
    chunkStatus: "pending",
    embeddingStatus: "pending",
    enabled: true,
    errorMessage: null,
    parentChunkCount: 0,
    childChunkCount: 0,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reused: false,
  });
}

// 有界等待异步调度结果，超时提供明确失败。
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await pause(2);
  }
  assert.fail("上传队列未在预期时间完成");
}

void describe("上传队列的真实调度行为", () => {
  void it("五份文件最多三个请求在途，某份完成立即补位", async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let peak = 0;
    const queue = new UploadQueue(
      () =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve(result());
          });
        }),
    );
    queue.add(Array.from({ length: 5 }, (_, index) => new File(["text"], `${String(index)}.txt`)));
    queue.start();
    assert.equal(releases.length, 3);
    releases[1]?.();
    await until(() => releases.length === 4);
    releases[0]?.();
    await until(() => releases.length === 5);
    releases[2]?.();
    releases[3]?.();
    releases[4]?.();
    await until(() => queue.getSnapshot().every((task) => task.status === "uploaded"));
    assert.equal(peak, 3);
    queue.dispose();
  });

  void it("总共三次请求，自动与手动重试复用幂等键", async () => {
    const keys: string[] = [];
    const queue = new UploadQueue(
      (task) => {
        keys.push(task.idempotencyKey);
        return Promise.reject(new TypeError("网络断开"));
      },
      () => 0,
    );
    queue.add([new File(["text"], "a.txt")]);
    queue.start();
    await until(() => queue.getSnapshot()[0]?.status === "failed");
    assert.equal(keys.length, 3);
    const task = queue.getSnapshot()[0];
    assert.ok(task);
    queue.retry(task.id);
    await until(() => keys.length === 6 && queue.getSnapshot()[0]?.status === "failed");
    assert.equal(new Set(keys).size, 1);
    queue.dispose();
  });

  void it("退避释放位置，其他文件不等待失败任务的定时器", async () => {
    const started: string[] = [];
    const queue = new UploadQueue(
      (task) => {
        started.push(task.file.name);
        return task.file.name === "0.txt"
          ? Promise.reject(new TypeError("网络错误"))
          : Promise.resolve(result());
      },
      () => 10_000,
    );
    queue.add(Array.from({ length: 5 }, (_, index) => new File(["text"], `${String(index)}.txt`)));
    queue.start();
    await until(() => started.length === 5);
    assert.equal(queue.getSnapshot()[0]?.status, "retry_waiting");
    queue.dispose();
  });

  void it("格式错误不自动重试，主动取消不会再发送请求", async () => {
    let calls = 0;
    const queue = new UploadQueue(() => {
      calls++;
      return Promise.reject(new UploadRequestError("格式错误", 400));
    });
    queue.add([new File(["text"], "a.txt")]);
    queue.start();
    await until(() => queue.getSnapshot()[0]?.status === "failed");
    assert.equal(calls, 1);
    queue.dispose();
    let aborted = false;
    const cancellable = new UploadQueue(
      (_task, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("取消", "AbortError"));
          }),
        ),
    );
    cancellable.add([new File(["text"], "a.txt")]);
    cancellable.start();
    const task = cancellable.getSnapshot()[0];
    assert.ok(task);
    cancellable.cancel(task.id);
    await until(() => aborted);
    assert.equal(cancellable.getSnapshot()[0]?.status, "cancelled");
    cancellable.dispose();
  });
});

void describe("退避和进度版本边界", () => {
  void it("重试窗口指数增长，随机抖动不超出窗口", () => {
    assert.equal(
      uploadRetryDelay(1, () => 0),
      500,
    );
    assert.equal(
      uploadRetryDelay(2, () => 1),
      2000,
    );
  });
  void it("旧快照不覆盖实时阶段，新处理版本可以从等待重新开始", () => {
    const event = {
      documentId: crypto.randomUUID(),
      stage: "embedding" as const,
      percent: 60,
      message: "向量化",
      timestamp: "2026-10-05T00:00:10.000Z",
      processVersion: 2,
    };
    assert.equal(
      mergeDocumentProgress(event, {
        ...event,
        stage: "parsing",
        timestamp: "2026-10-05T00:00:09.000Z",
      }),
      event,
    );
    assert.equal(
      mergeDocumentProgress(event, { ...event, processVersion: 1, stage: "completed" }),
      event,
    );
    assert.equal(
      mergeDocumentProgress(event, { ...event, processVersion: 3, stage: "pending" }).stage,
      "pending",
    );
  });
});
