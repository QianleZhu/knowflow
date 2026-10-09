import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  childChunks,
  db,
  documents,
  knowledgeBases,
  knowledgeItems,
  parentChunks,
} from "@knowflow/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { AliyunLlmService } from "../../../shared/llm/aliyun-llm.js";
import type {
  RetrievalCandidate,
  RetrievalChannel,
  RetrievalContextItem,
  RetrievalResult,
} from "./retrieval.types.js";

const VECTOR_TOP_K = 20;
const FTS_TOP_K = 20;
const KNOWLEDGE_ITEM_TOP_K = 10;
const RERANK_TOP_N = 30;
const RERANK_KEEP_N = 10;
const MAX_CONTEXT_TOKENS = 6000;

type DocumentRecallRow = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  childChunkId: string;
  parentChunkId: string;
  title: string;
  content: string;
  parentTitle: string | null;
  parentContent: string;
  headingPath: unknown;
  pageStart: number | null;
  pageEnd: number | null;
  chunkIndex: number;
  tokenCount: number | null;
  createdAt: Date;
  pageOrSection: string | null;
  score: number;
};

type KnowledgeItemRecallRow = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeItemId: string;
  title: string;
  content: string;
  summary: string | null;
  createdBy: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  status: "draft" | "pending_review" | "published" | "unpublished" | "expired" | "archived";
  viewCount: number;
  citeCount: number;
  likeCount: number;
  createdAt: Date;
  score: number;
};

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(AliyunLlmService)
    private readonly llm: AliyunLlmService,
  ) {}

  // 编排三路召回，记录每路父块去重后的排名，再进入跨路合并和精排。
  async retrieve(input: {
    query: string;
    rewrittenQueries?: string[];
    expandedKeywords?: string[];
    allowedKnowledgeBaseIds: string[];
  }): Promise<RetrievalResult> {
    // 语义检索使用原文和独立改写，全文检索使用原文和关键词扩展，两个查询集合保持职责隔离。
    const rewrittenQueries = this.uniqueNonEmpty(input.rewrittenQueries ?? []);
    const expandedKeywords = this.uniqueNonEmpty(input.expandedKeywords ?? []);
    const vectorQueries = this.uniqueNonEmpty([input.query, ...rewrittenQueries]);
    const ftsQueries = this.uniqueNonEmpty([input.query, ...expandedKeywords]);
    if (vectorQueries.length === 0 || input.allowedKnowledgeBaseIds.length === 0) {
      return this.emptyResult(
        input.query,
        rewrittenQueries,
        expandedKeywords,
        input.allowedKnowledgeBaseIds,
      );
    }

    // 一次生成所有语义查询的向量，避免改写查询被遗漏或重复请求模型。
    const queryEmbeddings = await this.llm.embedTexts(vectorQueries);
    // 原文和改写分别召回后统一合并，文档和知识条目都覆盖两条语义查询。
    const vectorRowsPromise = Promise.all(
      vectorQueries.map((query, index) =>
        this.recallVector(query, queryEmbeddings[index] ?? [], input.allowedKnowledgeBaseIds),
      ),
    ).then((rows) => rows.flat());
    const knowledgeRowsPromise = Promise.all(
      vectorQueries.map((query, index) =>
        this.recallKnowledgeItems(
          query,
          queryEmbeddings[index] ?? [],
          input.allowedKnowledgeBaseIds,
        ),
      ),
    ).then((rows) => rows.flat());
    // 三路并行召回；全文检索只接收原文和关键词扩展结果。
    const [vectorRows, ftsRows, knowledgeRows] = await Promise.all([
      vectorRowsPromise,
      this.recallFts(ftsQueries, input.allowedKnowledgeBaseIds),
      knowledgeRowsPromise,
    ]);
    // 各路先按父块或知识条目取最高分并排名，之后才跨路合并候选。
    const vectorCandidates = this.toDocumentCandidates(vectorRows, "vector");
    const ftsCandidates = this.toDocumentCandidates(ftsRows, "fts");
    const knowledgeItemCandidates = this.toKnowledgeItemCandidates(knowledgeRows);
    const merged = this.mergeCandidates([
      ...vectorCandidates,
      ...ftsCandidates,
      ...knowledgeItemCandidates,
    ]);
    let reranked: RetrievalCandidate[];
    try {
      reranked = await this.rerank(input.query, merged);
    } catch (error) {
      this.logger.warn(`Rerank failed, falling back to initial sort: ${this.errorMessage(error)}`);
      reranked = this.fallbackToInitialSort(merged);
    }
    const contexts = this.applyTokenBudget(reranked);

    return {
      query: input.query,
      rewrittenQueries,
      expandedKeywords,
      candidates: reranked,
      contexts,
      trace: {
        allowedKnowledgeBaseIds: input.allowedKnowledgeBaseIds,
        recalled: {
          vector: vectorRows.length,
          fts: ftsRows.length,
          knowledgeItem: knowledgeRows.length,
        },
        ranked: {
          vector: vectorCandidates.length,
          fts: ftsCandidates.length,
          knowledgeItem: knowledgeItemCandidates.length,
        },
        merged: merged.length,
        reranked: reranked.length,
        final: contexts.length,
      },
    };
  }

  // 对每个向量查询先按父块选出最高分子块，再限制唯一父块数量。
  private async recallVector(
    query: string,
    embedding: number[],
    allowedKnowledgeBaseIds: string[],
  ): Promise<DocumentRecallRow[]> {
    if (embedding.length === 0) {
      return [];
    }

    const vectorText = this.toPgVector(embedding);
    const scoreSql = sql<number>`1 - (${childChunks.embedding} <=> ${vectorText}::vector)`;
    // 先按父块分组并选择相似度最高的子块，外层再按父块分数排序和限量。
    const bestParentRows = db
      .selectDistinctOn([parentChunks.id], this.documentRecallSelection(scoreSql))
      .from(childChunks)
      .innerJoin(parentChunks, eq(parentChunks.id, childChunks.parentChunkId))
      .innerJoin(documents, eq(documents.id, childChunks.documentId))
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, childChunks.knowledgeBaseId))
      .where(
        and(
          inArray(childChunks.knowledgeBaseId, allowedKnowledgeBaseIds),
          isNull(knowledgeBases.deletedAt),
          eq(knowledgeBases.status, "active"),
          eq(documents.enabled, true),
          eq(documents.processStatus, "completed"),
          eq(parentChunks.enabled, true),
          eq(childChunks.enabled, true),
          eq(childChunks.embeddingStatus, "completed"),
          sql`${childChunks.embedding} is not null`,
          sql`${query} <> ''`,
        ),
      )
      .orderBy(parentChunks.id, desc(scoreSql), asc(childChunks.id))
      .as("vector_best_child_per_parent");
    return db
      .select()
      .from(bestParentRows)
      .orderBy(desc(bestParentRows.score), asc(bestParentRows.parentChunkId))
      .limit(VECTOR_TOP_K);
  }

  // 对全文查询先按父块选出 PGroonga 最高分子块，再限制唯一父块数量。
  private async recallFts(
    queries: string[],
    allowedKnowledgeBaseIds: string[],
  ): Promise<DocumentRecallRow[]> {
    const query = queries.join(" ");
    // PGroonga 原始分数是关键词命中次数（TF），用 s/(1+s) 压缩到 (0,1)，
    // 便于与向量余弦相似度（0~1）跨通道比较；单调变换不影响排序。
    const rawScoreSql = sql<number>`pgroonga_score(${childChunks}.tableoid, ${childChunks}.ctid)`;
    const scoreSql = sql<number>`(${rawScoreSql}) / (1 + (${rawScoreSql}))`;
    // 同一父块只保留 PGroonga 得分最高的子块，TopK 因此统计唯一父块数。
    const bestParentRows = db
      .selectDistinctOn([parentChunks.id], this.documentRecallSelection(scoreSql))
      .from(childChunks)
      .innerJoin(parentChunks, eq(parentChunks.id, childChunks.parentChunkId))
      .innerJoin(documents, eq(documents.id, childChunks.documentId))
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, childChunks.knowledgeBaseId))
      .where(
        and(
          inArray(childChunks.knowledgeBaseId, allowedKnowledgeBaseIds),
          isNull(knowledgeBases.deletedAt),
          eq(knowledgeBases.status, "active"),
          eq(documents.enabled, true),
          eq(documents.processStatus, "completed"),
          eq(parentChunks.enabled, true),
          eq(childChunks.enabled, true),
          // pgroonga_query_escape 防止用户输入被当作 PGroonga 查询语法解析
          sql`${childChunks.content} &@~ pgroonga_query_escape(${query})`,
        ),
      )
      .orderBy(parentChunks.id, desc(scoreSql), asc(childChunks.id))
      .as("fts_best_child_per_parent");
    return db
      .select()
      .from(bestParentRows)
      .orderBy(desc(bestParentRows.score), asc(bestParentRows.parentChunkId))
      .limit(FTS_TOP_K);
  }

  private async recallKnowledgeItems(
    query: string,
    embedding: number[],
    allowedKnowledgeBaseIds: string[],
  ): Promise<KnowledgeItemRecallRow[]> {
    if (embedding.length === 0) {
      return [];
    }

    const vectorText = this.toPgVector(embedding);
    return db
      .select(
        this.knowledgeItemRecallSelection(
          sql<number>`1 - (${knowledgeItems.embedding} <=> ${vectorText}::vector)`,
        ),
      )
      .from(knowledgeItems)
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, knowledgeItems.knowledgeBaseId))
      .where(
        and(
          inArray(knowledgeItems.knowledgeBaseId, allowedKnowledgeBaseIds),
          isNull(knowledgeBases.deletedAt),
          eq(knowledgeBases.status, "active"),
          eq(knowledgeItems.enabled, true),
          eq(knowledgeItems.status, "published"),
          sql`${knowledgeItems.embedding} is not null`,
          sql`${query} <> ''`,
        ),
      )
      .orderBy(desc(sql`1 - (${knowledgeItems.embedding} <=> ${vectorText}::vector)`))
      .limit(KNOWLEDGE_ITEM_TOP_K);
  }

  private documentRecallSelection(score: ReturnType<typeof sql<number>>) {
    return {
      id: childChunks.id,
      knowledgeBaseId: childChunks.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      documentId: childChunks.documentId,
      childChunkId: childChunks.id,
      parentChunkId: childChunks.parentChunkId,
      title: documents.title,
      content: childChunks.content,
      parentTitle: parentChunks.title,
      parentContent: parentChunks.content,
      headingPath: parentChunks.headingPath,
      pageStart: parentChunks.pageStart,
      pageEnd: parentChunks.pageEnd,
      chunkIndex: childChunks.chunkIndex,
      tokenCount: childChunks.tokenCount,
      createdAt: childChunks.createdAt,
      pageOrSection: sql<string | null>`coalesce(${parentChunks.title}, ${documents.title})`,
      score,
    };
  }

  private knowledgeItemRecallSelection(score: ReturnType<typeof sql<number>>) {
    return {
      id: knowledgeItems.id,
      knowledgeBaseId: knowledgeItems.knowledgeBaseId,
      knowledgeBaseName: knowledgeBases.name,
      knowledgeItemId: knowledgeItems.id,
      title: knowledgeItems.title,
      content: knowledgeItems.content,
      summary: knowledgeItems.summary,
      createdBy: knowledgeItems.createdBy,
      verifiedBy: knowledgeItems.verifiedBy,
      verifiedAt: knowledgeItems.verifiedAt,
      status: knowledgeItems.status,
      viewCount: knowledgeItems.viewCount,
      citeCount: knowledgeItems.citeCount,
      likeCount: knowledgeItems.likeCount,
      createdAt: knowledgeItems.createdAt,
      score,
    };
  }

  // 按业务主键保留最高分命中，并仅在唯一结果集合上生成从 1 开始的路内名次。
  private dedupeAndRankByMaxScore<T>(
    rows: T[],
    getKey: (row: T) => string,
    getScore: (row: T) => number,
    getTieKey: (row: T) => string = getKey,
  ): { row: T; rank: number }[] {
    const bestByKey = new Map<string, T>();
    for (const row of rows) {
      const key = getKey(row);
      const existing = bestByKey.get(key);
      if (
        existing === undefined ||
        getScore(row) > getScore(existing) ||
        (getScore(row) === getScore(existing) && getTieKey(row) < getTieKey(existing))
      ) {
        bestByKey.set(key, row);
      }
    }

    return [...bestByKey.entries()]
      .sort(([leftKey, leftRow], [rightKey, rightRow]) => {
        const scoreDifference = getScore(rightRow) - getScore(leftRow);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map(([, row], index) => ({ row, rank: index + 1 }));
  }

  // 将父块重复命中压成单个文档候选，并保存该通道内的 Max 分数排名。
  private toDocumentCandidates(
    rows: DocumentRecallRow[],
    channel: Extract<RetrievalChannel, "vector" | "fts">,
  ): RetrievalCandidate[] {
    return this.dedupeAndRankByMaxScore(
      rows,
      (row) => row.parentChunkId,
      (row) => row.score,
      (row) => row.childChunkId,
    ).map(({ row, rank }) => ({
      id: row.parentChunkId,
      sourceType: "knowledge_document",
      knowledgeBaseId: row.knowledgeBaseId,
      knowledgeBaseName: row.knowledgeBaseName,
      documentId: row.documentId,
      knowledgeItemId: null,
      childChunkId: row.childChunkId,
      parentChunkId: row.parentChunkId,
      title: row.title,
      content: row.content,
      parentContent: row.parentContent,
      snippet: this.snippet(row.content, 260),
      pageOrSection: row.pageOrSection,
      channels: [channel],
      channelRanks: { [channel]: rank },
      initialScore: row.score,
      rerankScore: null,
      knowledgeItemVerified: false,
      sourceExpired: false,
      tokenCount: this.estimateTokenCount(row.parentContent),
    }));
  }

  // 知识条目按条目 ID 取跨查询的最高分，再为该召回通道生成排名。
  private toKnowledgeItemCandidates(rows: KnowledgeItemRecallRow[]): RetrievalCandidate[] {
    return this.dedupeAndRankByMaxScore(
      rows,
      (row) => row.knowledgeItemId,
      (row) => row.score,
    ).map(({ row, rank }) => ({
      id: row.knowledgeItemId,
      sourceType: "knowledge_item",
      knowledgeBaseId: row.knowledgeBaseId,
      knowledgeBaseName: row.knowledgeBaseName,
      documentId: null,
      knowledgeItemId: row.knowledgeItemId,
      childChunkId: null,
      parentChunkId: null,
      title: row.title,
      content: row.content,
      parentContent: null,
      snippet: this.snippet(row.content, 260),
      pageOrSection: null,
      channels: ["knowledge_item"],
      channelRanks: { knowledge_item: rank },
      initialScore: row.score,
      rerankScore: null,
      knowledgeItemVerified: row.verifiedBy !== null,
      sourceExpired: row.status === "expired",
      tokenCount: this.estimateTokenCount(row.content),
    }));
  }

  // 合并同一文档父块或知识条目在不同召回通道中的结果，并保留各路名次。
  private mergeCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    const byKey = new Map<string, RetrievalCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.sourceType}:${candidate.id}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, candidate);
        continue;
      }

      const channels = new Set([...existing.channels, ...candidate.channels]);
      byKey.set(key, {
        ...existing,
        channels: [...channels],
        channelRanks: { ...existing.channelRanks, ...candidate.channelRanks },
        initialScore: Math.max(existing.initialScore, candidate.initialScore),
        childChunkId: existing.childChunkId ?? candidate.childChunkId,
        content:
          candidate.initialScore > existing.initialScore ? candidate.content : existing.content,
        snippet:
          candidate.initialScore > existing.initialScore ? candidate.snippet : existing.snippet,
      });
    }

    return [...byKey.values()].sort((left, right) => right.initialScore - left.initialScore);
  }

  private async rerank(
    query: string,
    candidates: RetrievalCandidate[],
  ): Promise<RetrievalCandidate[]> {
    const target = candidates.slice(0, RERANK_TOP_N);
    if (target.length === 0) {
      return [];
    }

    const results = await this.llm.rerank(
      query,
      target.map((candidate) => this.contextText(candidate)),
      Math.min(RERANK_KEEP_N, target.length),
    );
    const byIndex = new Map(results.map((result) => [result.index, result.relevanceScore]));
    return target
      .map((candidate, index) => ({
        ...candidate,
        rerankScore: byIndex.get(index) ?? null,
      }))
      .filter((candidate) => candidate.rerankScore !== null)
      .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0))
      .slice(0, RERANK_KEEP_N);
  }

  private fallbackToInitialSort(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    return candidates
      .map((candidate) => ({
        ...candidate,
        rerankScore: null,
      }))
      .sort((left, right) => right.initialScore - left.initialScore)
      .slice(0, RERANK_KEEP_N);
  }

  private applyTokenBudget(candidates: RetrievalCandidate[]): RetrievalContextItem[] {
    const contexts: RetrievalContextItem[] = [];
    let usedTokens = 0;
    for (const candidate of candidates) {
      const contextText = this.contextText(candidate);
      const tokenCount = this.estimateTokenCount(contextText);
      if (contexts.length > 0 && usedTokens + tokenCount > MAX_CONTEXT_TOKENS) {
        continue;
      }

      usedTokens += tokenCount;
      contexts.push({
        ...candidate,
        contextText,
        tokenCount,
        citationIndex: contexts.length + 1,
      });
    }
    return contexts;
  }

  private normalizeHeadingPath(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
      return null;
    }
    const headingPath = value.filter((item): item is string => typeof item === "string");
    return headingPath.length === 0 ? null : headingPath;
  }

  private contextText(candidate: RetrievalCandidate): string {
    return candidate.parentContent ?? candidate.content;
  }

  private snippet(content: string, maxLength: number): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  }

  private estimateTokenCount(content: string): number {
    return Math.max(1, Math.ceil(content.trim().length / 4));
  }

  private toPgVector(embedding: number[]): string {
    return `[${embedding.map((value) => String(value)).join(",")}]`;
  }

  private roundScore(value: number): number {
    return Number(value.toFixed(6));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // 在无查询或无授权知识库时返回结构完整的空召回结果。
  private emptyResult(
    query: string,
    rewrittenQueries: string[],
    expandedKeywords: string[],
    allowedKnowledgeBaseIds: string[],
  ): RetrievalResult {
    return {
      query,
      rewrittenQueries,
      expandedKeywords,
      candidates: [],
      contexts: [],
      trace: {
        allowedKnowledgeBaseIds,
        recalled: {
          vector: 0,
          fts: 0,
          knowledgeItem: 0,
        },
        ranked: {
          vector: 0,
          fts: 0,
          knowledgeItem: 0,
        },
        merged: 0,
        reranked: 0,
        final: 0,
      },
    };
  }

  // 规范化并去重检索查询，避免重复调用向量或全文召回。
  private uniqueNonEmpty(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
}
