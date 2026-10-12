import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRunEventEnvelopeSchema,
  agentRunListResponseSchema,
  agentRunSnapshotSchema,
  answerFeedbackRequestSchema,
  conversationMessagesResponseSchema,
  conversationSchema,
  createConversationRequestSchema,
  type AgentRunSnapshot,
  type AgentRunStatus,
  type AskStreamEvent,
  type FeedbackRating,
} from "@knowflow/shared";
import { ApiError, apiRequest, apiUrl, parseApiError, refreshAccess } from "../../lib/api";
import {
  getAgentRunReconnectDelay,
  isAgentRunTerminal,
  SseFrameDecoder,
} from "../../lib/agent-run-stream";
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

const MAX_AGENT_RUN_RECONNECT_ATTEMPTS = 8;
const AGENT_RUN_HEARTBEAT_TIMEOUT_MS = 45_000;

type ActiveAgentRun = { snapshot: AgentRunSnapshot; draftId: string };
type ObservationResult = AgentRunStatus | "disconnected" | "aborted";
type RetryableApiError = ApiError & { retryAfterMs?: number };

class SnapshotRequiredError extends Error {
  constructor() {
    super("运行事件已过期，需要读取服务端快照");
    this.name = "SnapshotRequiredError";
  }
}

class EventSequenceGapError extends Error {
  constructor() {
    super("运行事件序号不连续");
    this.name = "EventSequenceGapError";
  }
}

// 以 AbortSignal 可取消的计时器实现有界重连等待。
function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const finish = (): void => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const handleAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

// 为 SSE 读取增加 45 秒心跳空闲上限，避免静默断线永久卡住订阅。
async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let cancelTimeout = (): void => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("SSE 心跳超时")),
      AGENT_RUN_HEARTBEAT_TIMEOUT_MS,
    );
    cancelTimeout = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    cancelTimeout();
  }
}

// 把 HTTP 状态转换为用户能直接采取行动的网络错误说明。
function describeNetworkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "登录状态已失效，请重新登录后恢复运行。";
    if (error.status === 403) return "当前账号已无权读取此运行。";
    if (error.status === 404) return "运行记录不存在或已清理，请重新加载会话。";
    if (error.status === 410) return "运行快照已过期，请重新加载会话历史。";
    if (error.status === 429) return "请求过于频繁，系统会稍后重试连接。";
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "当前网络不可用；服务端仍会继续生成，网络恢复后可以恢复连接。";
  }
  return "连接中断；服务端仍会继续生成，稍后可恢复连接。";
}

// 映射服务端运行错误码，区分认证、权限、限流、服务和生成错误。
function describeRunError(snapshot: AgentRunSnapshot): string {
  switch (snapshot.errorCode) {
    case "authentication_required":
      return "登录状态已失效，请重新登录后查看运行结果。";
    case "permission_denied":
      return "权限已变化，当前账号无法继续此运行。已保留已生成内容。";
    case "rate_limited":
      return "服务繁忙或请求受限。已保留已生成内容，请稍后重新提问。";
    case "service_unavailable":
      return "服务暂时不可用。已保留已生成内容，请稍后重新提问。";
    case "worker_interrupted":
      return "生成服务意外中断。已保留已生成内容，可以重新提问。";
    case "generation_failed":
      return snapshot.errorMessage ?? "生成失败。已保留已生成内容，可以重新提问。";
    default:
      return snapshot.errorMessage ?? "运行失败。已保留已生成内容。";
  }
}

// 通过函数边界读取会被事件回调异步修改的布尔 Ref，避免静态控制流误判状态。
function readBooleanRef(ref: { current: boolean }): boolean {
  return ref.current;
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
  const [canResumeRun, setCanResumeRun] = useState(false);
  const [feedbackByMessageId, setFeedbackByMessageId] = useState<Record<string, FeedbackRating>>(
    {},
  );
  const [correctionFor, setCorrectionFor] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement>(null);
  const prevMessagesLenRef = useRef(0);
  const streamingRef = useRef(false);
  const askingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<ActiveAgentRun | null>(null);
  const pendingClientRequestIdRef = useRef<string | null>(null);
  const stopRequestedBeforeRunRef = useRef(false);
  const lastSequenceByRunRef = useRef(new Map<string, number>());
  const finalizedRunIdsRef = useRef(new Set<string>());
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
    controller?.abort();
    clearStreamDeltas();
    askingRef.current = false;
    streamingRef.current = false;
    streamConversationIdRef.current = null;
    activeRunRef.current = null;
    pendingClientRequestIdRef.current = null;
    stopRequestedBeforeRunRef.current = false;
    setCanResumeRun(false);
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

  // 用服务端快照修正草稿正文和状态，确保事件丢失时仍展示权威内容。
  const applyRunSnapshot = useCallback(
    (snapshot: AgentRunSnapshot, draftId: string): void => {
      if (selectedConversationIdRef.current !== snapshot.conversationId) return;
      // 快照只覆盖到 checkpointSequence；先提交帧缓存，避免覆盖游标更新但快照尚未包含的实时 delta。
      flushStreamDeltas();
      const completionState =
        snapshot.status === "failed" || snapshot.status === "cancelled"
          ? snapshot.status
          : undefined;

      setMessages((current) => {
        const assistantMessage = snapshot.assistantMessage;
        if (snapshot.status === "completed" && assistantMessage !== null) {
          const existingIndex = current.findIndex(
            (message) => message.id === assistantMessage.id || message.id === draftId,
          );
          if (existingIndex >= 0) {
            return current.map((message, index) =>
              index === existingIndex ? assistantMessage : message,
            );
          }
          const userIndex = current.findIndex((message) => message.id === snapshot.userMessageId);
          if (userIndex === -1) return [...current, assistantMessage];
          const next = [...current];
          next.splice(userIndex + 1, 0, assistantMessage);
          return next;
        }

        const existingIndex = current.findIndex(
          (message) =>
            message.id === draftId ||
            message.id === `failed-${snapshot.id}` ||
            message.id === `cancelled-${snapshot.id}`,
        );
        const localSequence = lastSequenceByRunRef.current.get(snapshot.id) ?? 0;
        const existingDraft = existingIndex >= 0 ? current[existingIndex] : undefined;
        const draft: DraftAssistantMessage = {
          id: completionState === undefined ? draftId : `${completionState}-${snapshot.id}`,
          conversationId: snapshot.conversationId,
          role: "assistant",
          content:
            localSequence > snapshot.checkpointSequence && existingDraft !== undefined
              ? existingDraft.content
              : snapshot.answer,
          noAnswerType: null,
          sources: [],
          recommendedQuestions: [],
          createdAt: snapshot.updatedAt,
          ...(completionState === undefined ? {} : { completionState }),
        };
        if (existingIndex >= 0) {
          return current.map((message, index) => (index === existingIndex ? draft : message));
        }
        const userIndex = current.findIndex((message) => message.id === snapshot.userMessageId);
        if (userIndex === -1) return [...current, draft];
        const next = [...current];
        next.splice(userIndex + 1, 0, draft);
        return next;
      });

      if (isAgentRunTerminal(snapshot.status)) {
        activeRunRef.current = null;
        setCanResumeRun(false);
        setError(snapshot.status === "failed" ? describeRunError(snapshot) : null);
        setStatusText("");
        askingRef.current = false;
        streamingRef.current = false;
        setIsAsking(false);
        streamConversationIdRef.current = null;
      } else {
        activeRunRef.current = { snapshot, draftId };
        setCanResumeRun(false);
        setIsAsking(true);
        askingRef.current = true;
        streamingRef.current = true;
      }
    },
    [flushStreamDeltas],
  );

  // 只应用当前会话且序号连续的 Agent 事件，重复事件在状态更新前丢弃。
  const handleStreamEvent = useCallback(
    (event: AskStreamEvent, draftId: string, streamConversationId: string): void => {
      if (selectedConversationIdRef.current !== streamConversationId) return;
      switch (event.type) {
        case "agent.step.started": {
          const stepLabels: Record<string, string> = {
            analyze_query: "理解问题中",
            execute_route_tasks: "执行意图任务中",
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
        case "agent.completed":
          flushStreamDeltas();
          setMessages((current) =>
            current.map((message) => (message.id === draftId ? event.message : message)),
          );
          break;
        case "agent.failed":
          flushStreamDeltas();
          setError(event.message);
          break;
        case "agent.cancelled":
          flushStreamDeltas();
          setStatusText(event.message);
          break;
        default:
          break;
      }
    },
    [appendStreamDelta, flushStreamDeltas],
  );

  // 通过 GET 读取已存在的 run 快照作为事件回放的高水位和断线兜底。
  const fetchRunSnapshot = useCallback(
    (runId: string) => apiRequest(`/runs/${runId}`, agentRunSnapshotSchema, { cache: "no-store" }),
    [],
  );

  // 订阅已有 run 的 SSE 事件；401 刷新后只重试 GET，不重新提交生成 POST。
  const readRunStream = useCallback(
    async (
      runId: string,
      conversationId: string,
      draftId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const read = () =>
        fetch(
          apiUrl(
            `/runs/${runId}/events?afterSequence=${String(lastSequenceByRunRef.current.get(runId) ?? 0)}`,
          ),
          {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            signal,
          },
        );
      let response = await read();
      if (response.status === 401) {
        const refreshed = await refreshAccess();
        if (!refreshed) {
          if (typeof window !== "undefined" && window.location.pathname !== "/login") {
            window.location.href = "/login";
          }
          throw new ApiError("登录状态已失效，请重新登录", 401);
        }
        response = await read();
      }
      if (!response.ok) {
        const error = new ApiError(
          await parseApiError(response),
          response.status,
        ) as RetryableApiError;
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
          error.retryAfterMs = Math.min(30_000, retryAfter * 1000);
        }
        throw error;
      }
      if (response.body === null) throw new Error("运行事件流没有响应正文");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const frameDecoder = new SseFrameDecoder();
      let finished = false;
      const dispatch = (frames: ReturnType<SseFrameDecoder["feed"]>): void => {
        for (const frame of frames) {
          if (frame.data === null) continue;
          const packet = agentRunEventEnvelopeSchema.parse(JSON.parse(frame.data));
          if (packet.runId !== runId) continue;
          if (packet.type === "snapshot_required") throw new SnapshotRequiredError();
          const previous = lastSequenceByRunRef.current.get(runId) ?? 0;
          if (packet.sequence <= previous) continue;
          if (packet.sequence !== previous + 1) throw new EventSequenceGapError();
          handleStreamEvent(packet.event, draftId, conversationId);
          lastSequenceByRunRef.current.set(runId, packet.sequence);
        }
      };

      try {
        while (!finished) {
          signal.throwIfAborted();
          const result = await readSseChunk(reader);
          if (result.done) {
            dispatch(frameDecoder.feed(decoder.decode()));
            dispatch(frameDecoder.flush());
            finished = true;
            continue;
          }
          // 任何有效 SSE 字节（包括心跳注释）都会重置空闲超时。
          dispatch(frameDecoder.feed(decoder.decode(result.value, { stream: true })));
        }
      } finally {
        if (!finished) await reader.cancel().catch(() => undefined);
      }
    },
    [handleStreamEvent],
  );

  // 有界指数退避订阅 run，按序号去重并在事件缺口时从服务端快照恢复。
  const observeRun = useCallback(
    async (
      initial: AgentRunSnapshot,
      draftId: string,
      signal: AbortSignal,
    ): Promise<ObservationResult> => {
      let snapshot = initial;
      lastSequenceByRunRef.current.set(
        initial.id,
        Math.max(initial.checkpointSequence, lastSequenceByRunRef.current.get(initial.id) ?? 0),
      );
      activeRunRef.current = { snapshot, draftId };
      streamConversationIdRef.current = snapshot.conversationId;
      applyRunSnapshot(snapshot, draftId);
      if (isAgentRunTerminal(snapshot.status)) {
        if (!finalizedRunIdsRef.current.has(snapshot.id)) {
          finalizedRunIdsRef.current.add(snapshot.id);
          onStreamFinished?.(snapshot.status);
        }
        return snapshot.status;
      }

      let retryError: unknown = null;
      for (let attempt = 0; attempt <= MAX_AGENT_RUN_RECONNECT_ATTEMPTS; attempt += 1) {
        if (signal.aborted) return "aborted";
        if (attempt > 0) {
          const offline = typeof navigator !== "undefined" && !navigator.onLine;
          setStatusText(offline ? "网络不可用，等待恢复连接" : "连接中断，正在恢复运行事件");
          const waitMs =
            (retryError instanceof Error && "retryAfterMs" in retryError
              ? Number((retryError as RetryableApiError).retryAfterMs)
              : 0) || getAgentRunReconnectDelay(attempt - 1);
          try {
            await waitForReconnect(waitMs, signal);
          } catch {
            return "aborted";
          }
        }

        retryError = null;
        try {
          await readRunStream(snapshot.id, snapshot.conversationId, draftId, signal);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return "aborted";
          retryError = error;
          if (
            error instanceof ApiError &&
            (error.status === 401 ||
              error.status === 403 ||
              error.status === 404 ||
              error.status === 410)
          ) {
            setError(describeNetworkError(error));
            if (error.status === 404 || error.status === 410) {
              flushStreamDeltas();
              finishDraftMessage(draftId, "failed");
              activeRunRef.current = null;
              askingRef.current = false;
              streamingRef.current = false;
              setIsAsking(false);
              setCanResumeRun(false);
              onStreamFinished?.("failed");
            } else {
              setCanResumeRun(true);
            }
            return "disconnected";
          }
        }

        try {
          signal.throwIfAborted();
        } catch {
          return "aborted";
        }
        try {
          snapshot = await fetchRunSnapshot(snapshot.id);
        } catch (error) {
          retryError = error;
          if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) {
            setError(describeNetworkError(error));
            if (error.status === 404 || error.status === 410) {
              flushStreamDeltas();
              finishDraftMessage(draftId, "failed");
              activeRunRef.current = null;
              askingRef.current = false;
              streamingRef.current = false;
              setIsAsking(false);
              setCanResumeRun(false);
              onStreamFinished?.("failed");
            } else {
              setCanResumeRun(true);
            }
            return "disconnected";
          }
        }
        if (retryError !== null) setError(describeNetworkError(retryError));
        const latestSequence = Math.max(
          snapshot.checkpointSequence,
          lastSequenceByRunRef.current.get(snapshot.id) ?? 0,
        );
        lastSequenceByRunRef.current.set(snapshot.id, latestSequence);
        applyRunSnapshot(snapshot, draftId);
        if (isAgentRunTerminal(snapshot.status)) {
          if (!finalizedRunIdsRef.current.has(snapshot.id)) {
            finalizedRunIdsRef.current.add(snapshot.id);
            onStreamFinished?.(snapshot.status);
          }
          return snapshot.status;
        }
        retryError ??= new Error("运行事件连接已关闭，服务端尚未写入终态。");
        if (attempt < MAX_AGENT_RUN_RECONNECT_ATTEMPTS) {
          setStatusText("服务端正在生成，恢复事件连接中");
          setError(describeNetworkError(retryError));
        }
      }

      setCanResumeRun(true);
      setStatusText("连接暂时中断，生成仍在服务器运行");
      setError("网络连接中断，已保留部分回答；可以恢复连接或停止生成。");
      return "disconnected";
    },
    [
      applyRunSnapshot,
      fetchRunSnapshot,
      finishDraftMessage,
      flushStreamDeltas,
      onStreamFinished,
      readRunStream,
    ],
  );

  // 用户断线后手动恢复时只打开 run 订阅，不重新发送问题。
  const resumeRun = useCallback(async (): Promise<void> => {
    const active = activeRunRef.current;
    if (active?.snapshot.conversationId !== selectedConversationIdRef.current) return;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setCanResumeRun(false);
    setError(null);
    setIsAsking(true);
    askingRef.current = true;
    streamingRef.current = true;
    const result = await observeRun(active.snapshot, active.draftId, controller.signal);
    if (abortControllerRef.current !== controller) return;
    abortControllerRef.current = null;
    if (result === "disconnected") setCanResumeRun(true);
  }, [observeRun]);

  // 建立带 clientRequestId 的 Agent 运行，并用返回的 runId 开始订阅。
  async function ask(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === "" || askingRef.current || agentId === "") return;
    askingRef.current = true;
    setIsAsking(true);
    setCanResumeRun(false);
    setError(null);
    setQuestion("");
    streamingRef.current = true;
    stopRequestedBeforeRunRef.current = false;
    const clientRequestId = crypto.randomUUID();
    pendingClientRequestIdRef.current = clientRequestId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    let localDraftId: string | null = null;

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
        sources: [],
        recommendedQuestions: [],
        createdAt: now,
      };
      const draft: DraftAssistantMessage = {
        id: `draft-${localId}`,
        conversationId,
        role: "assistant",
        content: "",
        noAnswerType: null,
        sources: [],
        recommendedQuestions: [],
        createdAt: now,
      };
      localDraftId = draft.id;
      setMessages((current) => [...current, userMessage, draft]);
      streamConversationIdRef.current = conversationId;

      let snapshot: AgentRunSnapshot;
      try {
        snapshot = await apiRequest(
          `/conversations/${conversationId}/messages`,
          agentRunSnapshotSchema,
          {
            method: "POST",
            body: JSON.stringify({ content: trimmed, clientRequestId }),
            signal: controller.signal,
          },
        );
      } catch (postError) {
        if (controller.signal.aborted) throw postError;
        // POST 响应可能在服务端创建 run 后丢失；用幂等键 GET 找回，绝不自动重发生成请求。
        try {
          snapshot = await apiRequest(
            `/runs/by-request/${clientRequestId}`,
            agentRunSnapshotSchema,
            { cache: "no-store", signal: controller.signal },
          );
        } catch {
          throw postError;
        }
      }

      pendingClientRequestIdRef.current = null;
      const draftId = `draft-${snapshot.id}`;
      setMessages((current) =>
        current.map((message) => {
          if (message.id === `local-user-${localId}`)
            return { ...message, id: snapshot.userMessageId };
          if (message.id === localDraftId)
            return { ...message, id: draftId, content: snapshot.answer };
          return message;
        }),
      );
      lastSequenceByRunRef.current.set(snapshot.id, snapshot.checkpointSequence);
      activeRunRef.current = { snapshot, draftId };
      applyRunSnapshot(snapshot, draftId);

      if (readBooleanRef(stopRequestedBeforeRunRef)) {
        stopRequestedBeforeRunRef.current = false;
        try {
          const cancelled = await apiRequest(
            `/runs/${snapshot.id}/cancel`,
            agentRunSnapshotSchema,
            { method: "POST" },
          );
          snapshot = cancelled;
          applyRunSnapshot(snapshot, draftId);
        } catch (error) {
          setError(`停止请求尚未确认：${error instanceof Error ? error.message : "网络不可用"}`);
        }
      }
      await observeRun(snapshot, draftId, controller.signal);
    } catch (caught) {
      if (controller.signal.aborted || (caught instanceof Error && caught.name === "AbortError"))
        return;
      if (localDraftId !== null && activeRunRef.current === null) {
        flushStreamDeltas();
        finishDraftMessage(localDraftId, "failed");
      }
      setError(caught instanceof Error ? caught.message : "提问失败");
      if (activeRunRef.current === null) onStreamFinished?.("failed");
    } finally {
      pendingClientRequestIdRef.current = null;
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        if (activeRunRef.current === null) {
          flushStreamDeltas();
          setIsAsking(false);
          setStatusText("");
          askingRef.current = false;
          streamingRef.current = false;
          streamConversationIdRef.current = null;
        } else if (!controller.signal.aborted) {
          // 订阅到达重试上限时 run 仍在服务器执行，继续锁住当前会话避免并发生成。
          setIsAsking(true);
          askingRef.current = true;
          streamingRef.current = true;
          setCanResumeRun(true);
        }
      }
    }
  }

  // 显式调用取消接口；只关闭 SSE 不会触发取消或丢失 AgentTrace。
  const stopGenerating = useCallback((): void => {
    if (!askingRef.current) return;
    flushStreamDeltas();
    setError(null);
    setStatusText("正在停止生成");
    const active = activeRunRef.current;
    if (active === null) {
      if (pendingClientRequestIdRef.current !== null) stopRequestedBeforeRunRef.current = true;
      return;
    }
    void apiRequest(`/runs/${active.snapshot.id}/cancel`, agentRunSnapshotSchema, {
      method: "POST",
    })
      .then((snapshot) => {
        applyRunSnapshot(snapshot, active.draftId);
        if (snapshot.status === "cancel_requested") setStatusText("正在停止生成");
      })
      .catch((error: unknown) => {
        setError(`停止请求未确认：${error instanceof Error ? error.message : "网络不可用"}`);
      });
  }, [applyRunSnapshot, flushStreamDeltas]);

  // 在完成、失败、取消的用户问题后插入快照答案，恢复页面刷新时的消息顺序。
  function insertRunMessage(
    current: DisplayMessage[],
    userMessageId: string,
    assistant: DisplayMessage,
  ): DisplayMessage[] {
    if (current.some((message) => message.id === assistant.id)) return current;
    const userIndex = current.findIndex((message) => message.id === userMessageId);
    if (userIndex === -1) return [...current, assistant];
    const next = [...current];
    next.splice(userIndex + 1, 0, assistant);
    return next;
  }

  // 加载会话消息与运行快照并自动恢复活动订阅及已保留的失败部分答案。
  const loadMessages = useCallback(async (): Promise<void> => {
    const conversationId = selectedConversationId;
    if (conversationId === "") {
      setMessages([]);
      activeRunRef.current = null;
      return;
    }
    if (streamingRef.current) return;
    try {
      const [messageResponse, runResponse] = await Promise.all([
        apiRequest(
          `/conversations/${conversationId}/messages`,
          conversationMessagesResponseSchema,
          {
            cache: "no-store",
          },
        ),
        apiRequest(`/conversations/${conversationId}/runs`, agentRunListResponseSchema, {
          cache: "no-store",
        }),
      ]);
      if (selectedConversationIdRef.current !== conversationId || readBooleanRef(streamingRef))
        return;
      let restored: DisplayMessage[] = [...messageResponse.items];
      const orderedRuns = [...runResponse.items].reverse();
      for (const run of orderedRuns) {
        if (run.status === "completed" && run.assistantMessage !== null) {
          restored = insertRunMessage(restored, run.userMessageId, run.assistantMessage);
        } else if (run.status === "failed" || run.status === "cancelled") {
          const completionState = run.status;
          const partial: DraftAssistantMessage = {
            id: `${completionState}-${run.id}`,
            conversationId: run.conversationId,
            role: "assistant",
            content: run.answer,
            noAnswerType: null,
            sources: [],
            recommendedQuestions: [],
            createdAt: run.updatedAt,
            completionState,
          };
          restored = insertRunMessage(restored, run.userMessageId, partial);
        } else {
          const draft: DraftAssistantMessage = {
            id: `draft-${run.id}`,
            conversationId: run.conversationId,
            role: "assistant",
            content: run.answer,
            noAnswerType: null,
            sources: [],
            recommendedQuestions: [],
            createdAt: run.createdAt,
          };
          restored = insertRunMessage(restored, run.userMessageId, draft);
        }
      }
      setMessages(restored);
      const active = runResponse.items.find((run) => !isAgentRunTerminal(run.status));
      if (active !== undefined) {
        const draftId = `draft-${active.id}`;
        const controller = new AbortController();
        abortControllerRef.current = controller;
        activeRunRef.current = { snapshot: active, draftId };
        streamConversationIdRef.current = conversationId;
        setIsAsking(true);
        askingRef.current = true;
        streamingRef.current = true;
        setStatusText("恢复运行连接中");
        const result = await observeRun(active, draftId, controller.signal);
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          if (result === "disconnected") setCanResumeRun(true);
        }
      }
    } catch (caught) {
      if (selectedConversationIdRef.current === conversationId) {
        setError(caught instanceof Error ? caught.message : "加载消息失败");
      }
    }
  }, [observeRun, selectedConversationId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // 切换会话时重置长度基准，使新会话加载完成后强制吸底到最新消息。
  useEffect(() => {
    prevMessagesLenRef.current = 0;
  }, [selectedConversationId]);

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
    canResumeRun,
    resumeRun,
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
