// 本文件执行有权限边界的目录查询，并把结果作为单个路由任务返回。
import { documents, db, knowledgeBases } from "@knowflow/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { AccessibleKnowledgeBase } from "../../agent-scope.js";
import {
  NAMED_CATALOG_PATTERN,
  NAMED_CATALOG_TASK_PATTERN,
  normalizeIntentText,
} from "../../query-router.config.js";
import {
  createRouteTaskResult,
  type RouteTask,
  type RouteTaskResult,
} from "../route-task.types.js";

type NamedKnowledgeBaseMatch = { type: "matched"; id: string } | { type: "unmatched" } | null;

// 目录查询始终先将用户提到的名称映射到后端已授权知识库，再访问有效文档。
export async function executeDocumentCatalogTask(input: {
  task: RouteTask;
  originalQuery: string;
  knowledgeScope: string[];
  accessibleKnowledgeBases: AccessibleKnowledgeBase[];
  requestedKnowledgeBaseIds: string[];
}): Promise<RouteTaskResult> {
  const namedKnowledgeBase = findNamedKnowledgeBaseId(
    input.task.query,
    input.originalQuery,
    input.accessibleKnowledgeBases,
  );
  if (namedKnowledgeBase?.type === "unmatched") {
    return createRouteTaskResult(input.task, {
      mode: "deterministic",
      status: "completed",
      content: "这个名称未匹配到唯一的可访问知识库，因此没有查询其文档目录。",
    });
  }

  const namedKnowledgeBaseId =
    namedKnowledgeBase?.type === "matched" ? namedKnowledgeBase.id : null;
  const requestedIds =
    namedKnowledgeBaseId === null ? input.requestedKnowledgeBaseIds : [namedKnowledgeBaseId];
  const scope = input.knowledgeScope.filter(
    (id) => requestedIds.length === 0 || requestedIds.includes(id),
  );
  if (scope.length === 0) {
    return createRouteTaskResult(input.task, {
      mode: "deterministic",
      status: "completed",
      content: "你当前没有可查询的资料范围，请从可访问知识库中选择。",
    });
  }

  const rows = await db
    .select({ title: documents.title, knowledgeBaseName: knowledgeBases.name })
    .from(documents)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, documents.knowledgeBaseId))
    .where(
      and(
        inArray(documents.knowledgeBaseId, scope),
        isNull(knowledgeBases.deletedAt),
        eq(knowledgeBases.status, "active"),
        eq(documents.enabled, true),
        eq(documents.processStatus, "completed"),
      ),
    )
    .orderBy(asc(knowledgeBases.name), asc(documents.title))
    .limit(51);
  if (rows.length === 0) {
    return createRouteTaskResult(input.task, {
      mode: "deterministic",
      status: "completed",
      content: "当前查询范围内没有已启用且处理完成的文档。",
    });
  }

  const items = rows.slice(0, 50).map((row) => ({
    title: sanitizeCatalogLabel(row.title),
    knowledgeBaseName: sanitizeCatalogLabel(row.knowledgeBaseName),
  }));
  const titles = items.map(
    (item, index) => `${String(index + 1)}. ${item.title}（${item.knowledgeBaseName}）`,
  );
  const suffix = rows.length > 50 ? "\n仅展示前 50 条，请缩小知识库范围查看。" : "";
  return createRouteTaskResult(input.task, {
    mode: "deterministic",
    status: "completed",
    content: `当前范围内可查询的文档：\n${titles.join("\n")}${suffix}`,
  });
}

// 仅从已授权库名中解析目录范围，名称缺失或歧义时不泄露任何库是否存在。
function findNamedKnowledgeBaseId(
  query: string,
  originalQuery: string,
  accessibleKnowledgeBases: AccessibleKnowledgeBase[],
): NamedKnowledgeBaseMatch {
  const normalizedQuery = normalizeIntentText(query);
  const normalizedOriginalQuery = normalizeIntentText(originalQuery);
  const match =
    NAMED_CATALOG_PATTERN.exec(normalizedOriginalQuery) ??
    NAMED_CATALOG_TASK_PATTERN.exec(normalizedOriginalQuery) ??
    NAMED_CATALOG_PATTERN.exec(normalizedQuery) ??
    NAMED_CATALOG_TASK_PATTERN.exec(normalizedQuery);
  if (match?.[1] === undefined) return null;
  const named = normalizeIntentText(match[1]);
  const matches = accessibleKnowledgeBases.filter((item) => {
    const name = normalizeIntentText(item.name);
    return named === name || named === name.replace(/(?:知识库|资料库|文档库)$/u, "库");
  });
  return matches.length === 1 && matches[0] !== undefined
    ? { type: "matched", id: matches[0].id }
    : { type: "unmatched" };
}

// 将文档标题中的换行和控制字符压成普通文本，防止目录数据破坏汇总格式。
function sanitizeCatalogLabel(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159) ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}
