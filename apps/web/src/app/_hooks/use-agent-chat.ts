import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerFeedbackRequestSchema,
  askStreamEventSchema,
  conversationMessagesResponseSchema,
  conversationSchema,
  createConversationRequestSchema,
  CSRF_HEADER_NAME,
  type AskStreamEvent,
  type FeedbackRating,
} from "@knowflow/shared";
import { apiRequest, apiUrl, getCsrfToken, parseApiError, refreshAccess } from "../../lib/api";
import { StreamDeltaBuffer } from "../../lib/stream-delta-buffer";
import { type DisplayMessage, type DraftAssistantMessage } from "../_components/chat-bubbles";

const emptyObjectSchema = {
  parse(input: unknown): Record<string, never> {
    if (typeof input === "object" && input !== null && Object.keys(input).length === 0) {
      return {};
    }
    throw new Error("响应格式无效");
  },
};

export function parseSseEvent(chunk: string): AskStreamEvent | null {
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(dataLine.slice(6));
  return askStreamEventSchema.parse(parsed);
}

// 管理聊天会话、SSE 流生命周期、增量缓冲和用户主动中断。
export function useAgentChat({
  agentId,
  initialConversationId = "",
  onConversationCreated,
  onStreamFinished,
}: {
  agentId: string;
  initialConversationId?: string;
  onConversationCreated?: (id: string) => void;
  onStreamFinished?: (result: "completed" | "failed" | "cancelled") => void;
}) {
  const [selectedConversationId, setSelectedConversationIdState] = useState(initialConversationId);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [feedbackByMessageId, setFeedbackByMessageId] = useState<Record<string, FeedbackRating>>(
    {},
  );
  const [correctionFor, setCorrectionFor] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLenRef = useRef(0);
  const streamingRef = useRef(false);
  const askingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const userStopControllerRef = useRef<AbortController | null>(null);
  const deltaBufferRef = useRef<StreamDeltaBuffer | null>(null);
  // 始终指向「当前选中会话」与「在途流所属会话」，供流事件归属校验与切换中断使用
  const selectedConversationIdRef = useRef(selectedConversationId);
  selectedConversationIdRef.current = selectedConversationId;
  const streamConversationIdRef = useRef<string | null>(null);

  // 将同一帧中收集的 delta 合并成一次消息状态更新。
  const appendStreamDelta = useCallback((draftId: string, delta: string) => {
    deltaBufferRef.current ??= new StreamDeltaBuffer((messageId, mergedDelta) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content}${mergedDelta}` }
            : message,
        ),
      );
    });
    deltaBufferRef.current.append(draftId, delta);
  }, []);

  // 立即提交暂存内容，避免完成或用户停止时丢掉最后一帧。
  const flushStreamDeltas = useCallback(() => {
    deltaBufferRef.current?.flush();
  }, []);

  // 丢弃会话切换后已不属于当前视图的待提交增量。
  const clearStreamDeltas = useCallback(() => {
    deltaBufferRef.current?.clear();
  }, []);

  // 把未持久化的回答草稿标成中断或失败，并保留已收到的正文。
  const finishDraftMessage = useCallback(
    (draftId: string, completionState: "cancelled" | "failed") => {
      const localId = draftId.slice("draft-".length);
      setMessages((current) =>
        current.map((message) =>
          message.id === draftId && message.role === "assistant"
            ? {
                ...message,
                id: `${completionState}-${localId}`,
                completionState,
              }
            : message,
        ),
      );
    },
    [],
  );

  // 中断在途流（切换/清空会话、切 Agent、卸载时）：清空状态以便新会话加载。
  const abortInFlightStream = useCallback(() => {
    const controller = abortControllerRef.current;
    abortControllerRef.current = null;
    userStopControllerRef.current = null;
    controller?.abort();
    clearStreamDeltas();
    askingRef.current = false;
    streamingRef.current = false;
    streamConversationIdRef.current = null;
    setIsAsking(false);
    setStatusText("");
  }, [clearStreamDeltas]);

  // 包装会话切换：切到「非在途流所属」的会话时中断旧流，避免旧流串台写入新会话
  const setSelectedConversationId = useCallback(
    (id: string) => {
      if (streamingRef.current && streamConversationIdRef.current !== id) {
        abortInFlightStream();
      }
      selectedConversationIdRef.current = id;
      setSelectedConversationIdState(id);
    },
    [abortInFlightStream],
  );

  useEffect(() => {
    return () => {
      abortInFlightStream();
    };
  }, [agentId, abortInFlightStream]);

  // Auto-scroll when messages change —— 只滚动对话消息容器自身，
  // 不能用 listEndRef.scrollIntoView：它会滚动所有可滚动祖先(含外层 main)，
  // 表现为「整个布局在动」，且滚动位置残留会被常驻 main 带到其他页。
  useEffect(() => {
    const end = listEndRef.current;
    if (end === null) {
      return;
    }
    // 找到最近的可滚动祖先(对话消息区 overflow-y-auto)，只滚它到底部。
    let container: HTMLElement | null = end.parentElement;
    while (container !== null) {
      const style = window.getComputedStyle(container);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        break;
      }
      container = container.parentElement;
    }
    if (container === null) {
      return;
    }
    // 新消息总是吸底；流式增量时仅当用户已贴近底部才吸底，避免打断上滑查看历史
    const isNewMessage = messages.length > prevMessagesLenRef.current;
    prevMessagesLenRef.current = messages.length;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (isNewMessage || distanceFromBottom < 120) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  const loadMessages = useCallback(async () => {
    if (selectedConversationId === "") {
      setMessages([]);
      return;
    }
    if (streamingRef.current) {
      return;
    }
    try {
      const response = await apiRequest(
        `/conversations/${selectedConversationId}/messages`,
        conversationMessagesResponseSchema,
        { cache: "no-store" },
      );
      setMessages(response.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载消息失败");
    }
  }, [selectedConversationId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // 切换会话时重置长度基准，使新会话加载完成后强制吸底到最新消息
  useEffect(() => {
    prevMessagesLenRef.current = 0;
  }, [selectedConversationId]);

  async function ensureConversation(): Promise<string> {
    if (selectedConversationId !== "") {
      return selectedConversationId;
    }
    const input = createConversationRequestSchema.parse({ agentId });
    const created = await apiRequest("/conversations", conversationSchema, {
      method: "POST",
      body: JSON.stringify(input),
    });
    selectedConversationIdRef.current = created.id;
    setSelectedConversationIdState(created.id);
    onConversationCreated?.(created.id);
    return created.id;
  }

  async function ask(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "" || askingRef.current || agentId === "") {
      return;
    }
    askingRef.current = true;
    setIsAsking(true);
    setError(null);
    setQuestion("");
    streamingRef.current = true;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let activeDraftId: string | null = null;
    try {
      const conversationId = await ensureConversation();
      controller.signal.throwIfAborted();
      const now = new Date().toISOString();
      const localId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        id: `local-user-${localId}`,
        conversationId,
        role: "user",
        content: trimmed,
        confidenceLevel: null,
        noAnswerType: null,
        citations: [],
        recommendedQuestions: [],
        createdAt: now,
      };
      const draft: DraftAssistantMessage = {
        id: `draft-${localId}`,
        conversationId,
        role: "assistant",
        content: "",
        noAnswerType: null,
        recommendedQuestions: [],
        createdAt: now,
      };
      activeDraftId = draft.id;
      setMessages((current) => [...current, userMessage, draft]);
      streamConversationIdRef.current = conversationId;
      const result = await streamAnswer(conversationId, trimmed, draft.id, controller.signal);
      onStreamFinished?.(result);
    } catch (caught) {
      if (controller.signal.aborted || (caught instanceof Error && caught.name === "AbortError")) {
        if (userStopControllerRef.current === controller) {
          if (activeDraftId !== null) {
            flushStreamDeltas();
            finishDraftMessage(activeDraftId, "cancelled");
          }
          userStopControllerRef.current = null;
          onStreamFinished?.("cancelled");
        }
        return;
      }
      if (activeDraftId !== null) {
        flushStreamDeltas();
        finishDraftMessage(activeDraftId, "failed");
      }
      setError(caught instanceof Error ? caught.message : "提问失败");
      onStreamFinished?.("failed");
    } finally {
      // 仅当 abortController 仍是本次创建的那个时才复位（切换/新流会替换它，旧流 finally 不误清）
      if (abortControllerRef.current === controller) {
        flushStreamDeltas();
        setIsAsking(false);
        setStatusText("");
        askingRef.current = false;
        streamingRef.current = false;
        abortControllerRef.current = null;
        streamConversationIdRef.current = null;
      }
    }
  }

  // 请求中止信号并保留当前已到达的回答内容。
  const stopGenerating = useCallback(() => {
    const controller = abortControllerRef.current;
    if (controller === null || !askingRef.current) return;
    userStopControllerRef.current = controller;
    flushStreamDeltas();
    setStatusText("正在停止生成");
    controller.abort();
  }, [flushStreamDeltas]);

  async function streamAnswer(
    conversationId: string,
    content: string,
    draftId: string,
    signal: AbortSignal,
  ): Promise<"completed" | "failed"> {
    const doFetch = () =>
      fetch(apiUrl(`/conversations/${conversationId}/messages`), {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER_NAME]: getCsrfToken() },
        credentials: "include",
        body: JSON.stringify({ content }),
        signal,
      });
    let response = await doFetch();
    // 流式走裸 fetch（绕过 apiRequest），需自行处理 401：刷新后重试一次，仍失败则跳登录
    if (response.status === 401) {
      const refreshed = await refreshAccess();
      if (!refreshed) {
        if (typeof window !== "undefined" && window.location.pathname !== "/login") {
          window.location.href = "/login";
        }
        throw new Error("登录状态已失效，请重新登录");
      }
      response = await doFetch();
    }
    if (!response.ok || response.body === null) {
      throw new Error(await parseApiError(response));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalResult: "completed" | "failed" | null = null;

    try {
      let result = await reader.read();
      while (!result.done) {
        if (signal.aborted) {
          await reader.cancel();
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = parseSseEvent(part);
          if (event !== null) {
            handleStreamEvent(event, draftId, conversationId);
            if (event.type === "agent.completed") terminalResult = "completed";
            if (event.type === "agent.failed") terminalResult = "failed";
          }
        }
        result = await reader.read();
      }
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        const event = parseSseEvent(buffer);
        if (event !== null) {
          handleStreamEvent(event, draftId, conversationId);
          if (event.type === "agent.completed") terminalResult = "completed";
          if (event.type === "agent.failed") terminalResult = "failed";
        }
      }
    } catch (error) {
      // 服务端终态事件已到达时，忽略随后用户取消读取造成的关闭异常。
      if (terminalResult === null) throw error;
    } finally {
      if (signal.aborted) {
        await reader.cancel();
      }
    }
    if (terminalResult !== null) return terminalResult;
    signal.throwIfAborted();
    throw new Error("流式连接意外中断，已收到的回答内容已保留，请重试。");
  }

  function handleStreamEvent(event: AskStreamEvent, draftId: string, streamConversationId: string) {
    // 归属校验：仅当流仍属于当前选中会话时才写入，防止切走后旧流串台
    if (selectedConversationIdRef.current !== streamConversationId) {
      return;
    }
    switch (event.type) {
      case "agent.started": {
        // 将临时用户消息替换为服务端消息 ID，以便失败 Trace 也能准确挂回该查询。
        const localUserMessageId = `local-user-${draftId.slice("draft-".length)}`;
        setMessages((current) =>
          current.map((message) =>
            message.id === localUserMessageId ? { ...message, id: event.userMessageId } : message,
          ),
        );
        break;
      }
      case "agent.step.started": {
        const stepLabels: Record<string, string> = {
          analyze_query: "理解问题中",
          retrieve_knowledge: "检索知识库中",
          rerank_context: "整理相关内容中",
          build_context: "构建上下文中",
          generate_answer_stream: "生成回答中",
        };
        setStatusText(stepLabels[event.step] ?? "处理中");
        break;
      }
      case "agent.answer.delta":
        appendStreamDelta(draftId, event.delta);
        break;
      case "agent.completed": {
        flushStreamDeltas();
        setMessages((current) => current.map((m) => (m.id === draftId ? event.message : m)));
        break;
      }
      case "agent.failed":
        flushStreamDeltas();
        finishDraftMessage(draftId, "failed");
        setError(event.message);
        break;
      default:
        break;
    }
  }

  async function sendFeedback(
    messageId: string,
    rating: FeedbackRating,
    extra?: {
      reason?: string;
      correctionContent?: string;
      suggestedSource?: string;
      suggestedIngestion?: boolean;
    },
  ) {
    setError(null);
    try {
      const payload = answerFeedbackRequestSchema.parse({ rating, ...extra });
      await apiRequest(`/messages/${messageId}/feedback`, emptyObjectSchema, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setFeedbackByMessageId((current) => ({ ...current, [messageId]: rating }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交反馈失败");
    }
  }

  function regenerate(message: DisplayMessage) {
    const idx = messages.findIndex((m) => m.id === message.id);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role === "user") {
        void ask(m.content);
        return;
      }
    }
  }

  return {
    selectedConversationId,
    setSelectedConversationId,
    messages,
    setMessages,
    question,
    setQuestion,
    statusText,
    error,
    setError,
    isAsking,
    stopGenerating,
    feedbackByMessageId,
    correctionFor,
    setCorrectionFor,
    listEndRef,
    ask,
    sendFeedback,
    regenerate,
  };
}
