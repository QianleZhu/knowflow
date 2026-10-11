import "../shared/config/load-env.js";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { db, closeDb, knowledgeBases, analyticsEvents } from "@knowflow/db";
import { eq, inArray, isNull } from "drizzle-orm";
import {
  CSRF_HEADER_NAME,
  documentProgressEventSchema,
  documentProgressListSchema,
  documentSchema,
  documentUploadSchema,
} from "@knowflow/shared";

// 真实接口验证：只创建带随机标识的测试文档，最后通过正式删除接口清理。
const base = process.env["API_PUBLIC_URL"] ?? "http://localhost:4000";
let cookie = "";
let csrf = "";
const created = new Set<string>();
const createdBases = new Set<string>();

// 登录时使用本地环境配置，凭据和 Cookie 不输出到日志。
async function login(): Promise<void> {
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env["SEED_ADMIN_USER"],
      password: process.env["SEED_ADMIN_PASSWORD"],
    }),
  });
  assert.ok(response.ok, "管理员登录失败");
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0] ?? "");
  cookie = cookies.join("; ");
  csrf = decodeURIComponent(cookies.find((value) => value.startsWith("csrf="))?.slice(5) ?? "");
  assert.ok(csrf, "缺少 CSRF Cookie");
}

// 用同一个真实单文件接口验证内容去重和操作幂等。
async function upload(knowledgeBaseId: string, content: string, key: string, name: string) {
  const body = new FormData();
  body.set("file", new File([content], name, { type: "text/plain" }));
  const response = await fetch(`${base}/knowledge-bases/${knowledgeBaseId}/documents`, {
    method: "POST",
    headers: { Cookie: cookie, [CSRF_HEADER_NAME]: csrf, "Idempotency-Key": key },
    body,
  });
  const result: unknown = await response.json();
  if (!response.ok) return { response, data: undefined };
  assert.ok(typeof result === "object" && result !== null && "data" in result);
  const data = documentUploadSchema.parse(result.data);
  created.add(data.id);
  return { response, data };
}

// 读取普通 JSON 响应的数据，拒绝非成功状态。
async function getData(path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  assert.ok(response.ok, `查询失败：${path}`);
  const body: unknown = await response.json();
  assert.ok(typeof body === "object" && body !== null && "data" in body);
  return body.data;
}

// 验证共享 SSE 的初始快照，读到事件后立即取消连接。
async function readSse(path: string): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("data:")) {
      const part = await reader.read();
      assert.ok(!part.done);
      text += decoder.decode(part.value, { stream: true });
    }
    const line = text.split("\n").find((value) => value.startsWith("data:"));
    assert.ok(line);
    const event = documentProgressEventSchema.parse(JSON.parse(line.slice(5)));
    assert.ok(
      event.processVersion !== undefined &&
        event.parseStatus !== undefined &&
        event.chunkStatus !== undefined,
    );
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

// 测试结束删除本次创建的文档，不触碰用户已有资料。
async function cleanup(): Promise<void> {
  try {
    for (const id of created) {
      const response = await fetch(`${base}/documents/${id}`, {
        method: "DELETE",
        headers: { Cookie: cookie, [CSRF_HEADER_NAME]: csrf },
      });
      assert.ok(response.ok, `测试文档清理失败：${id}`);
    }
    if (created.size > 0)
      await db.delete(analyticsEvents).where(inArray(analyticsEvents.targetId, [...created]));
    for (const id of createdBases) {
      await db.delete(analyticsEvents).where(eq(analyticsEvents.knowledgeBaseId, id));
      await db.delete(knowledgeBases).where(eq(knowledgeBases.id, id));
    }
  } finally {
    await closeDb();
  }
}

// 执行并发去重、冲突、跨库隔离、快照权限和真实处理终态验证。
async function main(): Promise<void> {
  try {
    await login();
    const bases = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(isNull(knowledgeBases.deletedAt))
      .limit(2);
    const firstBase = bases[0];
    const secondBase = bases[1];
    assert.ok(firstBase && secondBase, "需要两个可用知识库");
    const content = `并发上传验证 ${crypto.randomUUID()}\n用于验证文件解析与父子分块。`;
    const key = crypto.randomUUID();
    const first = await upload(firstBase.id, content, key, "upload-smoke.txt");
    assert.ok(first.data && !first.data.reused);
    const repeated = await Promise.all([
      upload(firstBase.id, content, key, "retry.txt"),
      upload(firstBase.id, content, crypto.randomUUID(), "renamed.txt"),
      upload(firstBase.id, content, crypto.randomUUID(), "concurrent.txt"),
    ]);
    assert.ok(repeated.every((item) => item.data?.id === first.data.id && item.data.reused));
    const raceContent = `${content} race`;
    const raceKey = crypto.randomUUID();
    const raced = await Promise.all([
      upload(firstBase.id, raceContent, raceKey, "race-a.txt"),
      upload(firstBase.id, raceContent, raceKey, "race-b.txt"),
      upload(firstBase.id, raceContent, crypto.randomUUID(), "race-c.txt"),
    ]);
    assert.equal(new Set(raced.map((item) => item.data?.id)).size, 1);
    assert.equal(raced.filter((item) => item.data?.reused === false).length, 1);
    const conflict = await upload(firstBase.id, `${content} changed`, key, "conflict.txt");
    assert.equal(conflict.response.status, 409);
    const crossBase = await upload(secondBase.id, content, crypto.randomUUID(), "cross-base.txt");
    assert.ok(crossBase.data && crossBase.data.id !== first.data.id && !crossBase.data.reused);
    const path = `/knowledge-bases/${firstBase.id}/documents/progress`;
    const snapshots = documentProgressListSchema.parse(
      await getData(`${path}-snapshot?ids=${first.data.id}`),
    );
    assert.equal(snapshots.length, 1);
    await readSse(`${path}?ids=${first.data.id}`);
    await readSse(`${path}?ids=${first.data.id}`);
    const wrongBase = await fetch(`${base}${path}-snapshot?ids=${crossBase.data.id}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(wrongBase.status, 404);
    const unauthenticated = await fetch(`${base}${path}-snapshot?ids=${first.data.id}`);
    assert.equal(unauthenticated.status, 401);
    let finalDocument = documentSchema.parse(await getData(`/documents/${first.data.id}`));
    for (
      let index = 0;
      index < 60 && !["completed", "failed"].includes(finalDocument.processStatus);
      index++
    ) {
      await pause(500);
      finalDocument = documentSchema.parse(await getData(`/documents/${first.data.id}`));
    }
    assert.equal(
      finalDocument.processStatus,
      "completed",
      finalDocument.errorMessage ?? "Worker 未完成测试文档",
    );
    assert.ok(finalDocument.parentChunkCount > 0 && finalDocument.childChunkCount > 0);
    console.log(
      JSON.stringify({
        sameKeyReplay: true,
        concurrentCreationDeduplicated: true,
        hashDeduplication: true,
        keyConflict409: true,
        crossBaseIsolation: true,
        sseSnapshotAndReconnect: true,
        unauthorizedRejected: true,
        processing: finalDocument.processStatus,
        parentChunks: finalDocument.parentChunkCount,
        childChunks: finalDocument.childChunkCount,
      }),
    );
  } finally {
    await cleanup();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
