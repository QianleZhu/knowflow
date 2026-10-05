"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { CSRF_HEADER_NAME, documentUploadSchema } from "@knowflow/shared";
import { apiUrl, getCsrfToken, parseApiError, refreshAccess } from "../../../../lib/api";
import { UploadQueue, UploadRequestError, type UploadTask } from "../../../../lib/upload-queue";

// 解析服务端限流提示，兼容秒数及 HTTP 日期。
function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, Date.parse(value) - Date.now()) || 0;
}

// 将 HTTP 上传接入独立调度器，提供响应超时、鉴权刷新和资源清理。
export function useUploadQueue(knowledgeBaseId: string) {
  const execute = useCallback(
    async (task: UploadTask, cancellation: AbortSignal) => {
      const timeout = AbortSignal.timeout(60_000);
      const signal = AbortSignal.any([cancellation, timeout]);
      const body = new FormData();
      body.set("file", task.file);
      // 同一轮所有重试和手动重试复用相同键，服务端负责内容哈希校验。
      const headers = new Headers({
        [CSRF_HEADER_NAME]: getCsrfToken(),
        "Idempotency-Key": task.idempotencyKey,
      });
      const init = { method: "POST", credentials: "include" as const, headers, body, signal };
      try {
        const response = await fetch(apiUrl(`/knowledge-bases/${knowledgeBaseId}/documents`), init);
        // 登录刷新后仍交给调度器进行下一次尝试，保证上传请求总数不超过三次。
        if (response.status === 401 && (await refreshAccess()))
          throw new UploadRequestError("登录状态已刷新，正在重试", 401, 0, true);
        if (!response.ok)
          throw new UploadRequestError(
            await parseApiError(response),
            response.status,
            retryAfterMs(response.headers.get("Retry-After")),
          );
        const result: unknown = await response.json();
        if (
          typeof result !== "object" ||
          result === null ||
          !("ok" in result) ||
          result.ok !== true ||
          !("data" in result)
        )
          throw new Error("上传响应格式无效");
        return documentUploadSchema.parse(result.data);
      } catch (error) {
        // 响应体读取超时也可能表现为 AbortError，统一识别为可重试的超时。
        if (timeout.aborted && !cancellation.aborted)
          throw new DOMException("上传请求超时", "TimeoutError");
        throw error;
      }
    },
    [knowledgeBaseId],
  );
  const queue = useMemo(() => new UploadQueue(execute), [execute]);
  const tasks = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  useEffect(() => () => queue.dispose(), [queue]);
  return { tasks, queue };
}
