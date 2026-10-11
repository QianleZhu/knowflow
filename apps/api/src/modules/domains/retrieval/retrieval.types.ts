export type RetrievalChannel = "vector" | "fts" | "knowledge_item";

export type RetrievalChannelRanks = Partial<Record<RetrievalChannel, number>>;

export type RetrievalChannelFailure = {
  channel: RetrievalChannel;
  message: string;
};

export type RetrievalSourceType = "knowledge_document" | "knowledge_item";

export type RetrievalCandidateMetadata = {
  headingPath: string[] | null;
};

export type RetrievalCandidate = {
  id: string;
  sourceType: RetrievalSourceType;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string | null;
  knowledgeItemId: string | null;
  childChunkId: string | null;
  parentChunkId: string | null;
  title: string;
  metadata: RetrievalCandidateMetadata | null;
  content: string;
  parentContent: string | null;
  snippet: string;
  pageOrSection: string | null;
  channels: RetrievalChannel[];
  channelRanks: RetrievalChannelRanks;
  rrfScore: number;
  rrfRank: number;
  initialScore: number;
  rerankScore: number | null;
  knowledgeItemVerified: boolean;
  sourceExpired: boolean;
};

export type RetrievalContextItem = RetrievalCandidate & {
  contextText: string;
  citationIndex: number;
};

export type RetrievalTrace = {
  allowedKnowledgeBaseIds: string[];
  recalled: {
    vector: number;
    fts: number;
    knowledgeItem: number;
  };
  ranked: {
    vector: number;
    fts: number;
    knowledgeItem: number;
  };
  merged: number;
  // 子块与知识条目跨路合并后，传给 Rerank 的候选总数。
  rrfReturned: number;
  // Rerank 成功处理的子块/知识条目数量，不代表最终父块上下文数。
  reranked: number;
  rerankFailure: string | null;
  // 父块 Max 聚合后交给提示词节点的上下文数量。
  final: number;
  channelFailures: RetrievalChannelFailure[];
};

export type RetrievalResult = {
  query: string;
  rewrittenQueries: string[];
  expandedKeywords: string[];
  candidates: RetrievalCandidate[];
  contexts: RetrievalContextItem[];
  trace: RetrievalTrace;
};
