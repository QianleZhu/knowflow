import type {
  Agent,
  AskStreamEvent,
  ConfidenceLevel,
  Conversation,
  ConversationMessage,
  NoAnswerType,
} from "@knowflow/shared";

import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { RetrievalResult } from "../retrieval/retrieval.types.js";
import type { ChatRequestMessage, ChatTokenUsage } from "../../../shared/llm/aliyun-llm.js";
import type { AccessibleKnowledgeBase } from "./agent-scope.js";
import type { RecentConversationMessage } from "./agent-memory.js";
import type { QueryPlan } from "./query-understanding.service.js";
import type {
  RouteTask,
  RouteTaskPlanSource,
  RouteTaskResult,
} from "./route-tasks/route-task.types.js";

export type SseEmitter = (event: AskStreamEvent) => Promise<void>;

export type RuntimeAgent = Agent & {
  systemPrompt: string | null;
};

export type ContextTokenBudgetTrace = {
  estimatedInputTokens: number;
  hardInputLimitTokens: number;
  safeInputLimitTokens: number;
  safetyMarginTokens: number;
  includedContextIds: string[];
  droppedContextIds: string[];
  retainedParentCount: number;
  historySummaryOmitted: boolean;
  requestHistoryMessageCount: number;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
};

export type AgentState = {
  user: AuthenticatedUser;
  conversation: Conversation;
  userMessageId: string;
  query: string;
  agent: RuntimeAgent | null;
  knowledgeScope: string[];
  accessibleKnowledgeBases: AccessibleKnowledgeBase[];
  recentMessages: RecentConversationMessage[];
  conversationSummary: string | null;
  queryPlan: QueryPlan | null;
  // 保存分类后拆出的原子任务、操作结果和拆解方式，供图节点与回答汇总共享。
  routeTasks: RouteTask[];
  routeTaskResults: RouteTaskResult[];
  routeTaskPlanSource: RouteTaskPlanSource | null;
  rewrittenQueries: string[];
  expandedKeywords: string[];
  retrieval: RetrievalResult | null;
  promptSnapshot: string | null;
  requestMessages?: ChatRequestMessage[] | null;
  contextTokenBudget?: ContextTokenBudgetTrace | null;
  actualTokenUsage?: ChatTokenUsage | null;
  answer: string;
  confidenceLevel: ConfidenceLevel | null;
  noAnswerType: NoAnswerType | null;
  assistantMessage: ConversationMessage | null;
  steps: { name: string; status: "started" | "completed"; at: string }[];
  startedAt: number;
  error: string | null;
  signal?: AbortSignal;
  emit: SseEmitter;
};

export type GraphEnvelope = {
  state: AgentState;
};
