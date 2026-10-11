"use client";

import { useRef, useState, useCallback, useEffect, type SyntheticEvent } from "react";
import { Archive, RotateCcw } from "lucide-react";
import type { AgentTraceSummary, Conversation } from "@knowflow/shared";
import { agentTraceListResponseSchema, conversationSchema } from "@knowflow/shared";

import { Button } from "../../components/ui/button";
import { EmptyState, Skeleton } from "../../components/ui/feedback";
import { AssistantBubble, UserBubble, CorrectionDialog } from "./chat-bubbles";
import { apiRequest } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useAgentChat } from "../_hooks/use-agent-chat";
import { TraceDetailsSheet } from "./trace-details-sheet";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export type AgentChatLayoutProps = {
  disableInput?: boolean;
  isLoading: boolean;
  error: string | null;
  conversations: Conversation[];
  conversationView: "active" | "archived";
  setConversationView: (view: "active" | "archived") => void;
  onRefreshConversations: (status: "active" | "archived") => Promise<unknown>;
  headerTitle: string;
  headerSubtitle: string;
  agentSelector?: React.ReactNode;
  showArchive?: boolean;
  emptyStateTitle: string;
  emptyStateDescription: string;
  chatHook: ReturnType<typeof useAgentChat>;
};

// 组合会话导航、聊天消息、运行记录与发送/停止输入区。
export function AgentChatLayout({
  disableInput,
  isLoading,
  error,
  conversations,
  conversationView,
  setConversationView,
  onRefreshConversations,
  headerTitle,
  headerSubtitle,
  agentSelector,
  showArchive = true,
  emptyStateTitle,
  emptyStateDescription,
  chatHook,
}: AgentChatLayoutProps) {
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "danger" } | null>(null);
  const [traceSummaries, setTraceSummaries] = useState<AgentTraceSummary[]>([]);
  const [traceLoadError, setTraceLoadError] = useState<string | null>(null);
  const [openedTraceId, setOpenedTraceId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((message: string, tone: "success" | "danger" = "success") => {
    setToast({ message, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const {
    selectedConversationId,
    setSelectedConversationId,
    messages,
    setMessages,
    question,
    setQuestion,
    statusText,
    isAsking,
    feedbackByMessageId,
    correctionFor,
    setCorrectionFor,
    listEndRef,
    ask,
    stopGenerating,
    sendFeedback,
    regenerate,
    setError,
  } = chatHook;

  const traceByAnswerId = new Map(
    traceSummaries
      .filter(
        (trace): trace is AgentTraceSummary & { messageId: string } => trace.messageId !== null,
      )
      .map((trace) => [trace.messageId, trace]),
  );
  const failedTraceByUserMessageId = new Map(
    traceSummaries
      .filter((trace) => trace.messageId === null)
      .map((trace) => [trace.userMessageId, trace]),
  );

  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const cancelledUserMessageId =
    latestAssistantMessage?.role === "assistant" &&
    "completionState" in latestAssistantMessage &&
    latestAssistantMessage.completionState === "cancelled" &&
    latestAssistantMessage.conversationId === selectedConversationId &&
    latestUserMessage?.conversationId === selectedConversationId &&
    !latestUserMessage.id.startsWith("local-user-")
      ? latestUserMessage.id
      : null;

  // 用户停止会先关闭 SSE，再由服务端写入 Trace；短暂重试以便停止后立即显示运行详情。
  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    setOpenedTraceId(null);
    setTraceSummaries([]);
    setTraceLoadError(null);
    if (selectedConversationId === "" || isAsking) return () => controller.abort();

    // 加载会话运行记录，并在刚停止的请求尚未落库时短暂重试。
    const loadTraceSummaries = async (): Promise<void> => {
      try {
        const response = await apiRequest(
          `/conversations/${selectedConversationId}/traces`,
          agentTraceListResponseSchema,
          { cache: "no-store", signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setTraceSummaries(response.items);
        const cancelledTraceSaved =
          cancelledUserMessageId === null ||
          response.items.some((trace) => trace.userMessageId === cancelledUserMessageId);
        if (!cancelledTraceSaved && attempt < 5) {
          attempt += 1;
          retryTimer = setTimeout(() => void loadTraceSummaries(), 300);
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          setTraceLoadError(error instanceof Error ? error.message : "加载运行记录失败");
        }
      }
    };

    void loadTraceSummaries();
    return () => {
      controller.abort();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [cancelledUserMessageId, isAsking, selectedConversationId]);

  async function handleArchive(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (processingId !== null) return;
    setProcessingId(id);
    try {
      await apiRequest(`/conversations/${id}/archive`, conversationSchema, { method: "POST" });
      if (selectedConversationId === id) {
        setSelectedConversationId("");
        setMessages([]);
      }
      await onRefreshConversations(conversationView);
      showToast("会话已归档");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "归档失败", "danger");
    } finally {
      setProcessingId(null);
    }
  }

  async function handleRestore(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (processingId !== null) return;
    setProcessingId(id);
    try {
      await apiRequest(`/conversations/${id}/restore`, conversationSchema, { method: "POST" });
      await onRefreshConversations(conversationView);
      showToast("会话已恢复");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "恢复失败", "danger");
    } finally {
      setProcessingId(null);
    }
  }

  function handleNewConversation() {
    setSelectedConversationId("");
    setMessages([]);
    setError(null);
  }

  async function handleAsk(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await ask(question);
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* 左:会话列表 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-neutral-50">
        <div className="flex items-center justify-between px-4 py-4">
          <h1 className="text-md font-semibold text-ink">{headerTitle}</h1>
          <Button size="sm" onClick={handleNewConversation}>
            + 新对话
          </Button>
        </div>
        <div className="px-4 pb-2">
          {agentSelector}
          <p className="text-xs text-ink-subtle mt-1">{headerSubtitle}</p>
        </div>

        {/* 视图切换 */}
        {showArchive && (
          <div className="px-4 pb-2">
            <div className="flex rounded-md bg-neutral-200/50 p-0.5">
              <button
                type="button"
                onClick={() => {
                  setConversationView("active");
                  setSelectedConversationId("");
                }}
                className={cn(
                  "flex-1 rounded text-xs font-medium py-1 text-center transition-colors",
                  conversationView === "active"
                    ? "bg-white text-ink shadow-sm"
                    : "text-ink-subtle hover:text-ink",
                )}
              >
                进行中
              </button>
              <button
                type="button"
                onClick={() => {
                  setConversationView("archived");
                  setSelectedConversationId("");
                }}
                className={cn(
                  "flex-1 rounded text-xs font-medium py-1 text-center transition-colors",
                  conversationView === "archived"
                    ? "bg-white text-ink shadow-sm"
                    : "text-ink-subtle hover:text-ink",
                )}
              >
                已归档
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-1">
          {isLoading ? (
            <div className="flex flex-col gap-1.5 px-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-subtle">
              {conversationView === "active" ? "还没有对话" : "没有已归档对话"}
            </p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedConversationId(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedConversationId(c.id);
                  }
                }}
                className={cn(
                  "group mb-0.5 flex w-full flex-col items-start rounded-md px-3 py-2 text-left transition-colors duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  c.id === selectedConversationId
                    ? "bg-brand-50 text-brand-700"
                    : "text-ink hover:bg-neutral-100",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="line-clamp-1 text-base font-medium flex-1 mr-2">{c.title}</span>
                  {showArchive &&
                    (conversationView === "active" ? (
                      <button
                        type="button"
                        title="归档"
                        disabled={processingId !== null}
                        onClick={(e) => void handleArchive(e, c.id)}
                        className={cn(
                          "opacity-0 transition-opacity p-1 rounded-sm group-hover:opacity-100 hover:bg-neutral-200/60 disabled:opacity-50 disabled:cursor-not-allowed",
                          c.id === selectedConversationId ? "hover:bg-brand-100" : "",
                        )}
                      >
                        <Archive
                          className={cn("size-3.5", processingId === c.id ? "animate-pulse" : "")}
                        />
                      </button>
                    ) : (
                      <button
                        type="button"
                        title="恢复"
                        disabled={processingId !== null}
                        onClick={(e) => void handleRestore(e, c.id)}
                        className={cn(
                          "opacity-0 transition-opacity p-1 rounded-sm group-hover:opacity-100 hover:bg-neutral-200/60 disabled:opacity-50 disabled:cursor-not-allowed",
                          c.id === selectedConversationId ? "hover:bg-brand-100" : "",
                        )}
                      >
                        <RotateCcw
                          className={cn("size-3.5", processingId === c.id ? "animate-spin" : "")}
                        />
                      </button>
                    ))}
                </div>
                <span className="text-xs text-ink-subtle">{formatDate(c.updatedAt)}</span>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* 右:对话流 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background relative">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
            {error !== null ? (
              <p className="rounded-md bg-danger-bg px-4 py-3 text-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {traceLoadError !== null ? (
              <p className="rounded-md bg-warning-bg px-4 py-2 text-xs text-warning" role="status">
                运行详情暂时无法加载：{traceLoadError}
              </p>
            ) : null}

            {!isLoading && messages.length === 0 ? (
              <EmptyState
                title={emptyStateTitle}
                description={emptyStateDescription}
                className="mt-[18vh]"
              />
            ) : null}

            {messages.map((message) =>
              message.role === "user" ? (
                <UserBubble
                  key={message.id}
                  content={message.content}
                  trace={failedTraceByUserMessageId.get(message.id)}
                  onOpenTrace={() => {
                    const trace = failedTraceByUserMessageId.get(message.id);
                    if (trace !== undefined) setOpenedTraceId(trace.traceId);
                  }}
                />
              ) : (
                <AssistantBubble
                  key={message.id}
                  message={message}
                  isStreaming={message.id.startsWith("draft-") && isAsking}
                  statusText={statusText}
                  feedback={feedbackByMessageId[message.id]}
                  onFeedback={(rating) => void sendFeedback(message.id, rating)}
                  onCorrection={() => setCorrectionFor(message.id)}
                  onRegenerate={() => regenerate(message)}
                  onAskRecommended={(q) => void ask(q)}
                  trace={traceByAnswerId.get(message.id)}
                  onOpenTrace={() => {
                    const trace = traceByAnswerId.get(message.id);
                    if (trace !== undefined) setOpenedTraceId(trace.traceId);
                  }}
                />
              ),
            )}
            <div ref={listEndRef} />
          </div>
        </div>

        {/* 输入区 */}
        <div className="border-t border-border bg-surface px-6 py-4">
          <form
            className="mx-auto flex max-w-3xl items-end gap-2"
            onSubmit={(event) => void handleAsk(event)}
          >
            <textarea
              aria-label="输入问题"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask(question);
                }
              }}
              placeholder="输入问题,Enter 发送,Shift+Enter 换行…"
              rows={2}
              disabled={disableInput}
              className="max-h-40 min-h-11 flex-1 resize-none rounded-lg border border-border bg-neutral-0 px-3 py-2.5 text-base text-ink placeholder:text-ink-subtle hover:border-neutral-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-100"
            />
            {isAsking ? (
              <Button type="button" size="lg" variant="secondary" onClick={stopGenerating}>
                停止生成
              </Button>
            ) : (
              <Button
                type="submit"
                size="lg"
                disabled={(disableInput ?? false) || question.trim() === ""}
              >
                发送
              </Button>
            )}
          </form>
        </div>

        {/* Toast */}
        {toast ? (
          <div
            className={cn(
              "absolute top-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg z-50",
              toast.tone === "success" ? "bg-success" : "bg-danger",
            )}
            role="status"
          >
            {toast.message}
          </div>
        ) : null}
      </main>

      {/* 纠错 Dialog */}
      <CorrectionDialog
        open={correctionFor !== null}
        onClose={() => setCorrectionFor(null)}
        onSubmit={(data) => {
          if (correctionFor !== null) {
            void sendFeedback(correctionFor, "correction", data);
            setCorrectionFor(null);
          }
        }}
      />
      <TraceDetailsSheet
        open={openedTraceId !== null}
        conversationId={selectedConversationId}
        trace={traceSummaries.find((item) => item.traceId === openedTraceId) ?? null}
        onOpenChange={(open) => {
          if (!open) setOpenedTraceId(null);
        }}
      />
    </div>
  );
}
