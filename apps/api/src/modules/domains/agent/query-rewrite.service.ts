import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import { AliyunLlmService } from "../../../shared/llm/aliyun-llm.js";
import type { RecentConversationMessage } from "./agent-memory.js";

// 查询增强节点只负责生成语义改写和全文检索关键词，不判断意图、不选择知识库、不回答问题。
const rewrittenQuerySchema = z
  .object({
    rewrittenQuery: z.string().trim().min(1).max(240),
  })
  .strict();

const ftsKeywordsSchema = z
  .object({
    keywords: z.array(z.string().trim().min(1).max(40)).max(8),
  })
  .strict();

export type QueryRewriteInput = {
  query: string;
  recentMessages: RecentConversationMessage[];
  conversationSummary: string | null;
};

export type QueryRewriteResult = {
  rewrittenQuery: string | null;
  expandedKeywords: string[];
};

// 面向向量检索生成自然语言独立查询，重点是补全上下文和保留业务约束。
const REWRITE_QUERY_PROMPT = `你是企业知识库系统中的“语义查询重写器”。
你的唯一任务是把用户当前问题改写成一条适合向量检索的、完整独立的查询语句。
你不判断是否需要检索，不回答问题，不选择知识库，不判断权限，不生成关键词列表。

输出要求：只输出 JSON：{"rewrittenQuery":"..."}。

改写规则：
- 根据对话历史补全“它、这个、那、多久、怎么办”等指代；
- 保留制度编号、产品名、技术名、金额、日期、人员范围和限制条件；
- 删除问候、客套和与检索无关的表达；
- 当前问题已经完整时只做轻量规范化；
- 历史信息不足时不得猜测，保留原问题中的不确定表达；
- 不得新增历史和当前输入中没有的事实；
- 使用用户原问题的语言，最多输出240个字符。

示例：
当前问题：“那需要多久？”；历史：“维修工单审核是怎样的流程？”
输出：{"rewrittenQuery":"维修工单审核流程需要多长时间"}

当前问题：“你好，请问报销需要哪些材料？”；无相关历史
输出：{"rewrittenQuery":"报销所需材料"}`;

// 面向全文检索生成短关键词，重点是保留精确词和有限扩展同义词。
const EXPAND_FTS_KEYWORDS_PROMPT = `你是企业知识库系统中的“全文检索关键词扩展器”。
你的唯一任务是从当前问题和必要对话历史中提取适合关键词匹配的检索词，并补充少量明确同义词。
你不判断是否需要检索，不生成完整查询句，不回答问题，不选择知识库，不判断权限。

输出要求：只输出 JSON：{"keywords":["关键词1","关键词2"]}。

关键词规则：
- 每个元素必须是短词或短语，不要输出问句、解释或完整回答；
- 保留制度编号、产品名、技术名、金额、日期、人员范围等精确词；
- 可以补充与原问题明确等价的常见表达，但不得凭空创造企业术语；
- 根据历史补全当前问题中的代词和省略对象；
- 去除问候、语气词和无检索价值的通用词；
- 最多输出8个关键词，按检索重要性排序，不重复；
- 使用用户原问题的语言。

示例：
当前问题：“那需要多久？”；历史：“维修工单审核是怎样的流程？”
输出：{"keywords":["维修工单","审核","流程","处理时长"]}

当前问题：“制度 FIN-2026-017 对超过5000元的费用有什么限制？”
输出：{"keywords":["FIN-2026-017","5000元","费用","限制"]}`;

@Injectable()
export class QueryRewriteService {
  private readonly logger = new Logger(QueryRewriteService.name);

  constructor(@Inject(AliyunLlmService) private readonly llm: AliyunLlmService) {}

  // 在同一个查询重写节点中并行完成语义改写和全文关键词扩展；两项任务继续使用各自的提示词。
  async rewriteAndExpand(input: QueryRewriteInput): Promise<QueryRewriteResult> {
    const [rewrittenQuery, expandedKeywords] = await Promise.all([
      this.rewriteQuery(input),
      this.expandFtsKeywords(input),
    ]);
    return { rewrittenQuery, expandedKeywords };
  }

  // 生成给向量检索使用的独立语义查询；失败时返回 null，由调用节点回退原文。
  async rewriteQuery(input: QueryRewriteInput): Promise<string | null> {
    try {
      const raw = await this.llm.completeChat({
        usageType: "query_understanding",
        temperature: 0,
        maxOutputTokens: 96,
        messages: [
          { role: "system", content: REWRITE_QUERY_PROMPT },
          { role: "user", content: JSON.stringify(this.buildContext(input)) },
        ],
      });
      return this.parseJson(raw, rewrittenQuerySchema).rewrittenQuery;
    } catch (error) {
      this.logger.warn(`Query rewrite failed, falling back to original query: ${this.errorMessage(error)}`);
      return null;
    }
  }

  // 生成给全文检索使用的关键词；失败时返回空数组，由检索层继续使用原文。
  async expandFtsKeywords(input: QueryRewriteInput): Promise<string[]> {
    try {
      const raw = await this.llm.completeChat({
        usageType: "query_understanding",
        temperature: 0,
        maxOutputTokens: 96,
        messages: [
          { role: "system", content: EXPAND_FTS_KEYWORDS_PROMPT },
          { role: "user", content: JSON.stringify(this.buildContext(input)) },
        ],
      });
      return this.normalizeKeywords(this.parseJson(raw, ftsKeywordsSchema).keywords);
    } catch (error) {
      this.logger.warn(`FTS keyword expansion failed, falling back to original query: ${this.errorMessage(error)}`);
      return [];
    }
  }

  // 只向查询增强模型提供当前问题和对话上下文，不传递知识库元数据或权限信息。
  private buildContext(input: QueryRewriteInput): {
    query: string;
    recentMessages: RecentConversationMessage[];
    conversationSummary: string | null;
  } {
    return {
      query: input.query,
      recentMessages: input.recentMessages.slice(-6).map((item, index, messages) => ({
        ...item,
        content: item.content.slice(
          0,
          index === messages.length - 1 && item.role === "assistant" ? 12000 : 1200,
        ),
      })),
      conversationSummary: input.conversationSummary?.slice(0, 1200) ?? null,
    };
  }

  // 解析模型可能返回的 JSON 代码块，并使用 Zod 严格校验输出结构。
  private parseJson<T>(raw: string, schema: z.ZodType<T>): T {
    const normalized = raw
      .replace(/^\s*```(?:json)?\s*/u, "")
      .replace(/\s*```\s*$/u, "");
    return schema.parse(JSON.parse(normalized));
  }

  // 去除空白和重复关键词，避免扩大全文检索噪声。
  private normalizeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  }

  // 统一转换未知异常，避免日志对象丢失具体错误信息。
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
