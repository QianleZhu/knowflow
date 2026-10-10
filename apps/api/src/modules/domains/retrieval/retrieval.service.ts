import { Inject, Injectable } from "@nestjs/common";
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
  RetrievalCandidateMetadata,
  RetrievalChannel,
  RetrievalChannelFailure,
  RetrievalResult,
} from "./retrieval.types.js";

// 携带全部通道失败时的检索追踪结果，让 Agent 错误处理器可以持久化后终止链路。
export class RetrievalAllChannelsFailedError extends Error {
  // 保留完整检索结果，让编排层在终止前落库失败追踪。
  constructor(readonly result: RetrievalResult) {
    super("所有召回通道均失败，检索链路已终止");
    this.name = RetrievalAllChannelsFailedError.name;
  }
}

// 向量与全文通道分别为每次查询召回最多 20 个子块，再在路内去重排名。
const VECTOR_TOP_K = 20;
const FTS_TOP_K = 20;
const KNOWLEDGE_ITEM_TOP_K = 10;
// 将子块粒度 RRF 排名前 50 的候选交给后续重排节点。
const RRF_CANDIDATE_TOP_N = 50;
// 使用标准 RRF 平滑常数，避免靠后名次的贡献过低。
const RRF_K = 60;

type ChannelRecallCollection = {
  recalled: number;
  candidates: RetrievalCandidate[];
  failure: RetrievalChannelFailure | null;
};

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
  metadata: unknown;
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
  constructor(
    @Inject(AliyunLlmService)
    private readonly llm: AliyunLlmService,
  ) {}

  // 编排三路召回，记录路内名次并计算跨路 RRF 总分和总排名。
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

    // 向量与知识条目共用查询向量；全文召回独立运行，避免 embedding 故障阻断 FTS。
    const queryEmbeddingsPromise = Promise.resolve().then(() => this.llm.embedTexts(vectorQueries));
    const [vectorResult, ftsResult, knowledgeItemResult] = await Promise.all([
      this.collectChannelRows(
        "vector",
        async () => {
          const queryEmbeddings = await queryEmbeddingsPromise;
          const rows = await Promise.all(
            vectorQueries.map((query, index) =>
              this.recallVector(query, queryEmbeddings[index] ?? [], input.allowedKnowledgeBaseIds),
            ),
          );
          return rows.flat();
        },
        (rows) => this.toDocumentCandidates(rows, "vector"),
      ),
      this.collectChannelRows(
        "fts",
        () => this.recallFts(ftsQueries, input.allowedKnowledgeBaseIds),
        (rows) => this.toDocumentCandidates(rows, "fts"),
      ),
      this.collectChannelRows(
        "knowledge_item",
        async () => {
          const queryEmbeddings = await queryEmbeddingsPromise;
          const rows = await Promise.all(
            vectorQueries.map((query, index) =>
              this.recallKnowledgeItems(
                query,
                queryEmbeddings[index] ?? [],
                input.allowedKnowledgeBaseIds,
              ),
            ),
          );
          return rows.flat();
        },
        (rows) => this.toKnowledgeItemCandidates(rows),
      ),
    ]);
    // 汇总各路独立结果和失败记录；成功通道照常参与后续 RRF 融合。
    const channelFailures = [vectorResult, ftsResult, knowledgeItemResult]
      .map((result) => result.failure)
      .filter((failure): failure is RetrievalChannelFailure => failure !== null);
    const merged = this.mergeCandidates([
      ...vectorResult.candidates,
      ...ftsResult.candidates,
      ...knowledgeItemResult.candidates,
    ]);
    const candidates = merged.slice(0, RRF_CANDIDATE_TOP_N);

    const result: RetrievalResult = {
      query: input.query,
      rewrittenQueries,
      expandedKeywords,
      candidates,
      contexts: [],
      trace: {
        allowedKnowledgeBaseIds: input.allowedKnowledgeBaseIds,
        recalled: {
          vector: vectorResult.recalled,
          fts: ftsResult.recalled,
          knowledgeItem: knowledgeItemResult.recalled,
        },
        ranked: {
          vector: vectorResult.candidates.length,
          fts: ftsResult.candidates.length,
          knowledgeItem: knowledgeItemResult.candidates.length,
        },
        merged: merged.length,
        rrfReturned: candidates.length,
        reranked: 0,
        rerankFailure: null,
        final: 0,
        channelFailures,
      },
    };

    if (channelFailures.length === 3) {
      throw new RetrievalAllChannelsFailedError(result);
    }
    return result;
  }

  // 单独收集每个召回通道；失败时记录错误并返回空结果，不影响其他通道。
  private async collectChannelRows<T>(
    channel: RetrievalChannel,
    recall: () => Promise<T[]>,
    rank: (rows: T[]) => RetrievalCandidate[],
  ): Promise<ChannelRecallCollection> {
    try {
      const rows = await recall();
      return { recalled: rows.length, candidates: rank(rows), failure: null };
    } catch (error) {
      return {
        recalled: 0,
        candidates: [],
        failure: { channel, message: this.errorMessage(error) },
      };
    }
  }

  // 对每个向量查询直接召回子块，父块聚合延迟到重排之后执行。
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
    return db
      .select(this.documentRecallSelection(scoreSql))
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
      .orderBy(desc(scoreSql), asc(childChunks.id))
      .limit(VECTOR_TOP_K);
  }

  // 对全文查询直接召回子块，保留同一父块下的多个候选供重排判断。
  private async recallFts(
    queries: string[],
    allowedKnowledgeBaseIds: string[],
  ): Promise<DocumentRecallRow[]> {
    const query = queries.join(" ");
    // PGroonga 原始分数是关键词命中次数（TF），用 s/(1+s) 压缩到 (0,1)，
    // 便于与向量余弦相似度（0~1）跨通道比较；单调变换不影响排序。
    const rawScoreSql = sql<number>`pgroonga_score(${childChunks}.tableoid, ${childChunks}.ctid)`;
    const scoreSql = sql<number>`(${rawScoreSql}) / (1 + (${rawScoreSql}))`;
    return db
      .select(this.documentRecallSelection(scoreSql))
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
      .orderBy(desc(scoreSql), asc(childChunks.id))
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
      // 检索候选从父块的元数据读取标题路径。
      metadata: parentChunks.metadata,
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

  // 同一路多查询命中相同子块时取最高分，并按子块分数生成通道内名次。
  private toDocumentCandidates(
    rows: DocumentRecallRow[],
    channel: Extract<RetrievalChannel, "vector" | "fts">,
  ): RetrievalCandidate[] {
    return this.dedupeAndRankByMaxScore(
      rows,
      (row) => row.childChunkId,
      (row) => row.score,
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
      rrfScore: 0,
      rrfRank: 0,
      initialScore: row.score,
      rerankScore: null,
      metadata: this.normalizeMetadata(row.metadata),
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
      rrfScore: 0,
      rrfRank: 0,
      initialScore: row.score,
      rerankScore: null,
      metadata: null,
      knowledgeItemVerified: row.verifiedBy !== null,
      sourceExpired: row.status === "expired",
      tokenCount: this.estimateTokenCount(row.content),
    }));
  }

  // 合并跨通道重复的同一子块或知识条目，并保留各路独立名次供 RRF 计算。
  private mergeCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
    const byKey = new Map<string, RetrievalCandidate>();
    for (const candidate of candidates) {
      const key = this.candidateMergeKey(candidate);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, candidate);
        continue;
      }

      const channels = new Set([...existing.channels, ...candidate.channels]);
      // 同一子块跨通道命中时，标题路径、正文和子块 ID 保持来自同一候选。
      const candidateHasHigherScore = candidate.initialScore > existing.initialScore;
      byKey.set(key, {
        ...existing,
        channels: [...channels],
        channelRanks: { ...existing.channelRanks, ...candidate.channelRanks },
        initialScore: Math.max(existing.initialScore, candidate.initialScore),
        ...(candidateHasHigherScore
          ? {
              childChunkId: candidate.childChunkId,
              content: candidate.content,
              metadata: candidate.metadata,
              pageOrSection: candidate.pageOrSection,
              snippet: candidate.snippet,
            }
          : {}),
      });
    }

    // 跨路合并后统一累加命中通道的倒数名次，再生成稳定的总排名。
    return [...byKey.values()]
      .map((candidate) => ({
        ...candidate,
        rrfScore: this.calculateRrfScore(candidate.channelRanks),
      }))
      .sort((left, right) => {
        const scoreDifference = right.rrfScore - left.rrfScore;
        if (scoreDifference !== 0) {
          return scoreDifference;
        }
        const leftKey = this.candidateMergeKey(left);
        const rightKey = this.candidateMergeKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((candidate, index) => ({ ...candidate, rrfRank: index + 1 }));
  }

  // 文档候选以子块 ID 作为 RRF 主键，知识条目仍以条目 ID 作为主键。
  private candidateMergeKey(candidate: RetrievalCandidate): string {
    const candidateId =
      candidate.sourceType === "knowledge_document"
        ? (candidate.childChunkId ?? candidate.id)
        : candidate.id;
    return `${candidate.sourceType}:${candidateId}`;
  }

  // 按标准 RRF 公式累计候选命中的各通道名次分数。
  private calculateRrfScore(channelRanks: RetrievalCandidate["channelRanks"]): number {
    return Object.values(channelRanks).reduce((score, rank) => score + 1 / (RRF_K + rank), 0);
  }

  // 从父块元数据读取可用于检索和提示词的标题路径。
  private normalizeMetadata(value: unknown): RetrievalCandidateMetadata | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const headingPathValue = "headingPath" in value ? value.headingPath : undefined;
    const headingPath = Array.isArray(headingPathValue)
      ? headingPathValue.filter((item): item is string => typeof item === "string")
      : [];
    return { headingPath: headingPath.length === 0 ? null : headingPath };
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
        rrfReturned: 0,
        reranked: 0,
        rerankFailure: null,
        final: 0,
        channelFailures: [],
      },
    };
  }

  // 将通道异常收敛为有限长度的错误信息，供运行追踪定位失败原因。
  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 500);
  }

  // 规范化并去重检索查询，避免重复调用向量或全文召回。
  private uniqueNonEmpty(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
}
