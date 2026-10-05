"use client";

import { useEffect, useRef, useState } from "react";
import {
  documentProgressEventSchema,
  documentProgressListSchema,
  type DocumentProgressEvent,
  type KnowledgeDocument,
} from "@knowflow/shared";
import { apiRequest, apiUrl } from "../../../../lib/api";
import {
  documentProgressSnapshot,
  isDocumentProcessing,
  mergeDocumentProgress,
} from "../../../../lib/document-progress-state";

export type ProgressConnection = "idle" | "connecting" | "connected" | "reconnecting" | "polling";

// 同一知识库共享进度连接，上传任务和当前页记录共同参与订阅，断线以快照兜底。
export function useDocumentProgress(
  knowledgeBaseId: string,
  documents: KnowledgeDocument[],
  onCompleted: () => void,
) {
  const [progressMap, setProgressMap] = useState<Record<string, DocumentProgressEvent>>({});
  const [connectionStatus, setConnectionStatus] = useState<ProgressConnection>("idle");
  const cache = useRef<{ knowledgeBaseId: string; events: Record<string, DocumentProgressEvent> }>({
    knowledgeBaseId,
    events: {},
  });
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const key = [
    ...new Set(
      documents
        .filter((document) => {
          const known =
            cache.current.knowledgeBaseId === knowledgeBaseId
              ? cache.current.events[document.id]
              : undefined;
          const latest = mergeDocumentProgress(known, documentProgressSnapshot(document));
          return isDocumentProcessing(latest.stage);
        })
        .map((document) => document.id),
    ),
  ]
    .sort()
    .join(",");

  // 列表和上传响应提供初始快照；版本合并避免刷新列表覆盖实时阶段。
  useEffect(() => {
    if (cache.current.knowledgeBaseId !== knowledgeBaseId)
      cache.current = { knowledgeBaseId, events: {} };
    const events = { ...cache.current.events };
    for (const document of documents)
      events[document.id] = mergeDocumentProgress(
        events[document.id],
        documentProgressSnapshot(document),
      );
    cache.current.events = events;
    setProgressMap(events);
  }, [documents, knowledgeBaseId]);

  useEffect(() => {
    if (!key) {
      setConnectionStatus("idle");
      return;
    }
    const ids = key.split(",");
    let disposed = false;
    const abort = new AbortController();
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanups: (() => void)[] = [];

    // 所有来源统一按处理版本合并，终态通知合并触发一次列表刷新。
    const accept = (event: DocumentProgressEvent) => {
      if (disposed || !ids.includes(event.documentId)) return;
      const previous = cache.current.events[event.documentId];
      const latest = mergeDocumentProgress(previous, event);
      if (latest === previous) return;
      cache.current.events = { ...cache.current.events, [event.documentId]: latest };
      setProgressMap(cache.current.events);
      if (
        !isDocumentProcessing(latest.stage) &&
        (!previous || isDocumentProcessing(previous.stage))
      ) {
        clearTimeout(completionTimer);
        completionTimer = setTimeout(() => {
          if (!disposed) onCompletedRef.current();
        }, 100);
      }
    };

    // 每批最多五十个 ID，连接按批共享，不为每个文件单独开连接。
    for (let offset = 0; offset < ids.length; offset += 50) {
      const group = ids.slice(offset, offset + 50);
      const query = new URLSearchParams({ ids: group.join(",") });
      const base = `/knowledge-bases/${knowledgeBaseId}/documents`;
      let source: EventSource | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let connected = false;
      let lastMessage = Date.now();
      let lastPoll = 0;
      let polling = false;

      // 断线每十秒查询，在线每三十秒核对；无响应时亦可恢复状态。
      const poll = async () => {
        if (disposed || polling) return;
        polling = true;
        lastPoll = Date.now();
        try {
          const events = await apiRequest(
            `${base}/progress-snapshot?${query}`,
            documentProgressListSchema,
            { signal: abort.signal, cache: "no-store" },
          );
          events.forEach(accept);
        } catch {
          if (!abort.signal.aborted) setConnectionStatus("polling");
        } finally {
          polling = false;
        }
      };

      // 手动控制重连退避，关闭 EventSource 自带重连以免重复连接。
      const connect = () => {
        if (disposed) return;
        source?.close();
        setConnectionStatus(failures ? "reconnecting" : "connecting");
        const current = new EventSource(apiUrl(`${base}/progress?${query}`), {
          withCredentials: true,
        });
        source = current;
        current.onopen = () => {
          if (disposed || source !== current) return;
          connected = true;
          lastMessage = Date.now();
          setConnectionStatus("connected");
        };
        current.onmessage = (message) => {
          if (disposed || source !== current) return;
          try {
            accept(documentProgressEventSchema.parse(JSON.parse(message.data as string)));
            lastMessage = Date.now();
            failures = 0;
          } catch {
            current.close();
            connected = false;
            scheduleReconnect();
          }
        };
        current.onerror = () => {
          if (disposed || source !== current) return;
          current.close();
          connected = false;
          void poll();
          scheduleReconnect();
        };
      };

      // 随机指数退避封顶三十秒；与上传的三次尝试限制相互独立。
      const scheduleReconnect = () => {
        if (disposed || reconnectTimer !== undefined) return;
        failures += 1;
        setConnectionStatus(failures > 3 ? "polling" : "reconnecting");
        const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
        reconnectTimer = setTimeout(
          () => {
            reconnectTimer = undefined;
            connect();
          },
          ceiling / 2 + (Math.random() * ceiling) / 2,
        );
      };
      connect();
      const watchdog = setInterval(() => {
        if (connected && Date.now() - lastMessage > 45_000) {
          source?.close();
          connected = false;
          scheduleReconnect();
        }
        if (Date.now() - lastPoll >= (connected ? 30_000 : 10_000)) void poll();
      }, 5_000);
      cleanups.push(() => {
        source?.close();
        clearTimeout(reconnectTimer);
        clearInterval(watchdog);
      });
    }
    return () => {
      disposed = true;
      abort.abort();
      // 终态导致订阅集合变化时也要刷新，不能因清理定时器丢失通知。
      if (completionTimer !== undefined) {
        clearTimeout(completionTimer);
        onCompletedRef.current();
      }
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [knowledgeBaseId, key]);

  return { progressMap, connectionStatus };
}
