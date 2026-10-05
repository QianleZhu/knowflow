"use client";

import { useCallback, useMemo, useRef } from "react";
import { documentSchema } from "@knowflow/shared";
import { apiRequest } from "../../../../lib/api";
import { useUploadQueue } from "./use-upload-queue";

// 对外只暴露上传操作和成功文档，分页列表与进度连接由页面组合。
export function useDocumentUpload(knowledgeBaseId: string, onChanged: () => void) {
  const { tasks, queue } = useUploadQueue(knowledgeBaseId);
  const processingRetries = useRef(new Set<string>());
  const uploadedDocuments = useMemo(
    () => tasks.flatMap((task) => (task.document ? [task.document] : [])),
    [tasks],
  );
  const retryProcessing = useCallback(
    async (documentId: string) => {
      if (processingRetries.current.has(documentId)) return;
      processingRetries.current.add(documentId);
      try {
        // 解析重试只使用已有文档 ID，不重发文件，也不创建新记录。
        const document = await apiRequest(`/documents/${documentId}/reprocess`, documentSchema, {
          method: "POST",
        });
        queue.updateDocument({ ...document, reused: true });
        onChanged();
      } finally {
        processingRetries.current.delete(documentId);
      }
    },
    [onChanged, queue],
  );
  return {
    tasks,
    uploadedDocuments,
    retryProcessing,
    isUploading: tasks.some((task) =>
      ["queued", "uploading", "retry_waiting"].includes(task.status),
    ),
    addFiles: (files: File[]) => queue.add(files),
    removeTask: (id: string) => queue.remove(id),
    startUpload: () => queue.start(),
    retryUpload: (id: string) => queue.retry(id),
    cancelUpload: (id: string) => queue.cancel(id),
  };
}
