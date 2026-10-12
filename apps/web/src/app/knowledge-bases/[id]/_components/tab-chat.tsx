"use client";

import { useCallback, useEffect, useState } from "react";
import {
  agentListResponseSchema,
  conversationListResponseSchema,
  type Agent,
  type Conversation,
} from "@knowflow/shared";
import { apiRequest } from "../../../../lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../components/ui/select";
import { useAgentChat } from "../../../_hooks/use-agent-chat";
import { AgentChatLayout } from "../../../_components/agent-chat-layout";

export function TabChat({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationView, setConversationView] = useState<"active" | "archived">("active");
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastSelectedAgentStorageKey = `knowflow:last-selected-agent:knowledge-base:${knowledgeBaseId}`;

  // 初始化专家列表时优先恢复上次使用的 Agent，后续才能找回该 Agent 下的会话。
  useEffect(() => {
    async function loadAgents() {
      setLoadingAgents(true);
      setError(null);
      try {
        const response = await apiRequest(
          `/agents?knowledgeBaseId=${knowledgeBaseId}`,
          agentListResponseSchema,
          {
            cache: "no-store",
          },
        );
        setAgents(response.items);
        if (response.items.length > 0) {
          const defaultAgent = response.items.find((a: Agent) => a.isDefault) ?? response.items[0];
          let lastSelectedAgentId: string | null = null;
          try {
            lastSelectedAgentId = window.localStorage.getItem(lastSelectedAgentStorageKey);
          } catch {
            // 浏览器禁用本地存储时回退到默认 Agent。
          }
          const lastSelectedAgent = response.items.find(
            (agent) => agent.id === lastSelectedAgentId,
          );
          const agentToSelect = lastSelectedAgent ?? defaultAgent;
          if (agentToSelect) setSelectedAgentId(agentToSelect.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载专家 Agent 失败");
      } finally {
        setLoadingAgents(false);
      }
    }
    void loadAgents();
  }, [knowledgeBaseId, lastSelectedAgentStorageKey]);

  // 记住当前知识库内选择的 Agent，刷新后用它恢复对应会话列表。
  useEffect(() => {
    if (selectedAgentId === "") return;
    try {
      window.localStorage.setItem(lastSelectedAgentStorageKey, selectedAgentId);
    } catch {
      // 本地存储不可用时仍允许正常切换 Agent。
    }
  }, [lastSelectedAgentStorageKey, selectedAgentId]);

  const refreshConversations = useCallback(
    async (status: "active" | "archived") => {
      if (selectedAgentId === "") return [];
      try {
        const response = await apiRequest(
          `/conversations?status=${status}`,
          conversationListResponseSchema,
          {
            cache: "no-store",
          },
        );
        // 每个 agent 对应自己的会话列表：只显示当前选中 agent 的会话（与全局 /agents 页一致）
        const list = response.items.filter((c) => c.agentId === selectedAgentId);
        setConversations(list);
        return list;
      } catch {
        return [];
      }
    },
    [selectedAgentId],
  );

  useEffect(() => {
    if (!loadingAgents && selectedAgentId !== "") {
      setLoadingConversations(true);
      void refreshConversations(conversationView).finally(() => setLoadingConversations(false));
    } else if (!loadingAgents && agents.length === 0) {
      setLoadingConversations(false);
    }
  }, [loadingAgents, agents.length, selectedAgentId, conversationView, refreshConversations]);

  const chatHook = useAgentChat({
    agentId: selectedAgentId,
    onConversationCreated: () => {
      if (conversationView === "archived") {
        setConversationView("active");
      } else {
        void refreshConversations("active");
      }
    },
    onStreamFinished: () => {
      void refreshConversations("active");
    },
  });

  // Sync selectedAgentId when a conversation is selected
  useEffect(() => {
    if (chatHook.selectedConversationId) {
      const conv = conversations.find((c) => c.id === chatHook.selectedConversationId);
      if (conv && conv.agentId !== selectedAgentId) {
        setSelectedAgentId(conv.agentId);
      }
    }
  }, [chatHook.selectedConversationId, conversations, selectedAgentId]);

  const agentSelector = (
    <Select
      value={selectedAgentId === "" ? undefined : selectedAgentId}
      onValueChange={(next) => {
        // 先标记列表正在切换，避免用旧 Agent 的会话恢复新 Agent 的选择。
        setLoadingConversations(true);
        setSelectedAgentId(next);
        chatHook.setSelectedConversationId("");
        chatHook.setMessages([]);
      }}
      disabled={agents.length <= 1}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={agents.length === 0 ? "无可用专家" : "选择专家 Agent"} />
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <AgentChatLayout
      disableInput={selectedAgentId === ""}
      isLoading={loadingAgents || loadingConversations}
      error={error ?? chatHook.error}
      conversations={conversations}
      conversationView={conversationView}
      setConversationView={setConversationView}
      onRefreshConversations={refreshConversations}
      headerTitle="专家 Agent"
      headerSubtitle="本知识库专家"
      agentSelector={agentSelector}
      showArchive={true}
      emptyStateTitle={agents.length === 0 ? "该知识库暂无可用专家 Agent" : "开始提问"}
      emptyStateDescription={
        agents.length === 0
          ? "请联系管理员在「专家 Agent 管理」标签页创建并发布。"
          : "该专家 Agent 熟知本知识库内容，向它提问吧。"
      }
      conversationStorageKey={
        selectedAgentId === ""
          ? null
          : `knowflow:last-selected-conversation:knowledge-base:${knowledgeBaseId}:agent:${selectedAgentId}`
      }
      chatHook={chatHook}
    />
  );
}
