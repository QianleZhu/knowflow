import { conversationMessages, conversations, db } from "@knowflow/db";
import { and, asc, eq, inArray } from "drizzle-orm";

import { AliyunLlmService } from "../../../shared/llm/aliyun-llm.js";
import {
  appendCompressedSummarySegment,
  buildMessageCompressionPrompt,
  clampSummary,
  selectMessagesForRollingSummary,
} from "./agent-memory.js";
import type { ConversationSummaryJobResult } from "./conversation-summary-queue.js";

// 只压缩摘要游标之后、最近六条消息之前的原始历史，并追加为独立摘要段。
export async function processConversationSummary(
  llm: AliyunLlmService,
  conversationId: string,
): Promise<ConversationSummaryJobResult> {
  const [conversation] = await db
    .select({
      rollingSummary: conversations.rollingSummary,
      summarizedMessageCount: conversations.summarizedMessageCount,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conversation === undefined) {
    return { conversationId, status: "skipped" };
  }

  const messages = await db
    .select({
      id: conversationMessages.id,
      role: conversationMessages.role,
      content: conversationMessages.content,
      createdAt: conversationMessages.createdAt,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.conversationId, conversationId),
        inArray(conversationMessages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(asc(conversationMessages.createdAt));
  const selection = selectMessagesForRollingSummary(
    messages,
    conversation.summarizedMessageCount,
  );
  if (selection.messagesToSummarize.length === 0) {
    return {
      conversationId,
      status: "skipped",
      summarizedMessageCount: conversation.summarizedMessageCount,
    };
  }

  const summary = clampSummary(
    await llm.completeChat({
      messages: [
        {
          role: "system",
          content: "You compress a new batch of conversation messages. Output only this batch's summary.",
        },
        {
          role: "user",
          content: buildMessageCompressionPrompt(selection.messagesToSummarize),
        },
      ],
      usageType: "query_understanding",
      temperature: 0,
      maxOutputTokens: 700,
    }),
  );
  if (summary.length === 0) {
    return {
      conversationId,
      status: "skipped",
      summarizedMessageCount: conversation.summarizedMessageCount,
    };
  }

  await db
    .update(conversations)
    .set({
      rollingSummary: appendCompressedSummarySegment(
        conversation.rollingSummary,
        conversation.summarizedMessageCount,
        selection.summarizedMessageCount,
        summary,
      ),
      summarizedMessageCount: selection.summarizedMessageCount,
      updatedAt: new Date(),
    })
    // 用摘要游标做乐观并发控制，避免并发任务重复追加同一批压缩内容。
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.summarizedMessageCount, conversation.summarizedMessageCount),
      ),
    );

  return {
    conversationId,
    status: "completed",
    summarizedMessageCount: selection.summarizedMessageCount,
  };
}
