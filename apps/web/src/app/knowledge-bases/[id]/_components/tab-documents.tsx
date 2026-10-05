"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  documentListResponseSchema,
  documentSchema,
  type KnowledgeDocument,
  type DocumentProgressEvent,
  createImprovementTasksResponseSchema,
} from "@knowflow/shared";

import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Checkbox } from "../../../../components/ui/checkbox";
import { Dialog } from "../../../../components/ui/dialog";
import { EmptyState, Skeleton } from "../../../../components/ui/feedback";
import { Input } from "../../../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../components/ui/select";
import { TagBadge } from "../../../../components/ui/tag-badge";
import { apiRequest, emptyObjectSchema, replaceDocumentTags } from "../../../../lib/api";
import { useDocumentProgress } from "../_hooks/use-document-progress";
import { useDocumentUpload } from "../_hooks/use-document-upload";
import { DocumentProcessingSteps } from "./document-processing-steps";
import { useTagFilter } from "../_hooks/use-tag-filter";
import { useTags } from "../_hooks/use-tags";
import { Pagination } from "./pagination";
import { TagFilterPopover } from "./tag-filter-popover";
import { TagManagerDialog } from "./tag-manager-dialog";
import { TagPickerPopover } from "./tag-picker-popover";
import { DocumentPreviewDialog } from "./document-preview-dialog";

type TabDocumentsProps = {
  knowledgeBaseId: string;
  canManage: boolean;
};

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "pending", label: "等待中" },
  { value: "parsing", label: "解析中" },
  { value: "chunking", label: "切分中" },
  { value: "embedding", label: "向量化中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
];

const statusBadgeTone: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  parsing: "info",
  chunking: "info",
  embedding: "info",
  completed: "success",
  failed: "danger",
};

const statusLabels: Record<string, string> = {
  pending: "等待中",
  parsing: "解析中",
  chunking: "切分中",
  embedding: "向量化中",
  completed: "已完成",
  failed: "失败",
};

export function TabDocuments({ knowledgeBaseId, canManage }: TabDocumentsProps) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [extractingIds, setExtractingIds] = useState<Set<string>>(new Set());
  const [archivedMode, setArchivedMode] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<{ ids: string[] } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ ids: string[] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[] } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<KnowledgeDocument | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const {
    tags: allTags,
    loading: tagsLoading,
    create: createTag,
    update: updateTagFn,
    remove: removeTag,
  } = useTags(knowledgeBaseId);
  const tagFilter = useTagFilter();

  const pageSize = 20;
  const loadRequestIdRef = useRef(0);
  const successTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadDocuments = useCallback(async () => {
    const reqId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (keyword.trim()) params.set("keyword", keyword.trim());
      if (status && status !== "all") params.set("status", status);
      if (tagFilter.queryValue) params.set("tagIds", tagFilter.queryValue);
      params.set("archived", archivedMode ? "true" : "false");
      const response = await apiRequest(
        `/knowledge-bases/${knowledgeBaseId}/documents?${params.toString()}`,
        documentListResponseSchema,
        { cache: "no-store" },
      );
      if (reqId === loadRequestIdRef.current) {
        setDocuments(response.items);
        setTotal(response.total);
      }
    } catch (caught) {
      if (reqId === loadRequestIdRef.current)
        setError(caught instanceof Error ? caught.message : "加载文档失败");
    } finally {
      if (reqId === loadRequestIdRef.current) setLoading(false);
    }
  }, [knowledgeBaseId, page, keyword, status, tagFilter.queryValue, archivedMode]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(
    () => () => {
      clearTimeout(successTimer.current);
      clearTimeout(debounceRef.current);
    },
    [],
  );

  // 翻页或改筛选时清空跨页累积的选择，避免批量操作误作用到不可见的已选项
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, status, keyword, tagFilter.queryValue, archivedMode]);

  // 上传成功记录立即参与订阅，不受当前分页、搜索条件影响。
  const refreshDocuments = useCallback(() => {
    void loadDocuments();
  }, [loadDocuments]);
  const upload = useDocumentUpload(knowledgeBaseId, refreshDocuments);
  const trackedDocuments = useMemo(() => {
    const byId = new Map<string, KnowledgeDocument>();
    for (const document of [...upload.uploadedDocuments, ...documents]) {
      const previous = byId.get(document.id);
      if (!previous || Date.parse(document.updatedAt) >= Date.parse(previous.updatedAt))
        byId.set(document.id, document);
    }
    return [...byId.values()];
  }, [documents, upload.uploadedDocuments]);
  const { progressMap, connectionStatus } = useDocumentProgress(
    knowledgeBaseId,
    trackedDocuments,
    refreshDocuments,
  );
  const uploadedKey = upload.uploadedDocuments
    .map((document) => document.id)
    .sort()
    .join(",");
  // 一批同时完成的上传合并刷新列表，不再关闭弹窗以保留处理步骤。
  useEffect(() => {
    if (!uploadedKey) return;
    const timer = setTimeout(() => void loadDocuments(), 150);
    return () => clearTimeout(timer);
  }, [uploadedKey, loadDocuments]);

  function handleKeywordChange(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setKeyword(value);
      setPage(1);
    }, 300);
  }

  // 上传弹窗和列表共用解析重试，返回的新版本继续由进度 hook 跟踪。
  async function handleReprocess(docId: string) {
    setActionError(null);
    try {
      await upload.retryProcessing(docId);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "重试失败");
    }
  }

  async function handleConfirmArchive() {
    if (!archiveTarget) return;
    setActionLoading(true);
    setActionError(null);

    const results = await Promise.allSettled(
      archiveTarget.ids.map((docId) =>
        apiRequest(`/documents/${docId}/archive`, documentSchema, { method: "POST" }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    setArchiveTarget(null);
    setSelectedIds(new Set());
    await loadDocuments();

    if (rejected > 0) {
      if (fulfilled === 0) {
        setActionError(`归档失败 ${String(rejected)} 个文档`);
      } else {
        setActionError(`归档完成，成功 ${String(fulfilled)} 个，失败 ${String(rejected)} 个`);
      }
    } else {
      setActionSuccess(`归档成功 ${String(fulfilled)} 个文档`);
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setActionSuccess(null), 3000);
    }
    setActionLoading(false);
  }

  async function handleConfirmRestore() {
    if (!restoreTarget) return;
    setActionLoading(true);
    setActionError(null);

    const results = await Promise.allSettled(
      restoreTarget.ids.map((docId) =>
        apiRequest(`/documents/${docId}/restore`, documentSchema, { method: "POST" }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    setRestoreTarget(null);
    setSelectedIds(new Set());
    await loadDocuments();

    if (rejected > 0) {
      if (fulfilled === 0) {
        setActionError(`恢复失败 ${String(rejected)} 个文档`);
      } else {
        setActionError(`恢复完成，成功 ${String(fulfilled)} 个，失败 ${String(rejected)} 个`);
      }
    } else {
      setActionSuccess(`恢复成功 ${String(fulfilled)} 个文档`);
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setActionSuccess(null), 3000);
    }
    setActionLoading(false);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setActionLoading(true);
    setActionError(null);

    const results = await Promise.allSettled(
      deleteTarget.ids.map((docId) =>
        apiRequest(`/documents/${docId}`, emptyObjectSchema, { method: "DELETE" }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    setDeleteTarget(null);
    setSelectedIds(new Set());
    await loadDocuments();

    if (rejected > 0) {
      if (fulfilled === 0) {
        setActionError(`删除失败 ${String(rejected)} 个文档`);
      } else {
        setActionError(`删除完成，成功 ${String(fulfilled)} 个，失败 ${String(rejected)} 个`);
      }
    } else {
      setActionSuccess(`删除成功 ${String(fulfilled)} 个文档`);
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setActionSuccess(null), 3000);
    }
    setActionLoading(false);
  }

  function toggleSelect(docId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  const allSelected = documents.length > 0 && selectedIds.size === documents.length;
  function toggleAll() {
    setSelectedIds((prev) =>
      prev.size === documents.length ? new Set() : new Set(documents.map((d) => d.id)),
    );
  }

  const handleExtract = async (documentId: string) => {
    setActionError(null);
    setActionSuccess(null);
    setExtractingIds((prev) => new Set(prev).add(documentId));
    try {
      const res = await apiRequest(
        `/knowledge-bases/${knowledgeBaseId}/improvement-tasks/generate`,
        createImprovementTasksResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({ documentId }),
        },
      );
      const msg =
        res.created > 0
          ? `已生成 ${String(res.created)} 条候选条目，可在『知识改进/审核台』查看审批`
          : "未生成新候选条目（可能已提炼过），可在『知识改进/审核台』查看已有条目";
      setActionSuccess(msg);
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setActionSuccess(null), 5000);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "提炼失败");
    } finally {
      setExtractingIds((prev) => {
        const next = new Set(prev);
        next.delete(documentId);
        return next;
      });
    }
  };

  // 打标签：全量替换，用返回的标签列表更新该行
  async function handleReplaceDocTags(docId: string, tagIds: string[]) {
    const updated = await replaceDocumentTags(docId, { tagIds });
    setDocuments((prev) =>
      prev.map((doc) => (doc.id === docId ? { ...doc, tags: updated.items } : doc)),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Input
            placeholder="搜索文档名..."
            defaultValue={keyword}
            onChange={(e) => handleKeywordChange(e.target.value)}
            className="max-w-xs"
          />
          <Select
            value={status}
            onValueChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={archivedMode ? "archived" : "in-use"}
            onValueChange={(next) => {
              setArchivedMode(next === "archived");
              setPage(1);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="视图" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="in-use">在用</SelectItem>
              <SelectItem value="archived">已归档</SelectItem>
            </SelectContent>
          </Select>
          <TagFilterPopover
            allTags={allTags}
            selectedTagIds={tagFilter.selectedTagIds}
            onToggle={(tagId) => {
              tagFilter.toggle(tagId);
              setPage(1);
            }}
            onClear={() => {
              tagFilter.clear();
              setPage(1);
            }}
          />
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setTagManagerOpen(true)}>
              管理标签
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setActionError(null);
                setUploadOpen(true);
              }}
            >
              上传文档
            </Button>
          </div>
        ) : null}
      </div>

      {canManage && documents.length > 0 ? (
        <div className="flex items-center gap-3 px-0.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <Checkbox checked={allSelected} onCheckedChange={() => toggleAll()} aria-label="全选" />
            全选
          </label>
          {selectedIds.size > 0 ? (
            <>
              <span className="text-sm text-ink-muted">
                已选 <span className="font-medium text-ink tabular-nums">{selectedIds.size}</span>
              </span>
              {!archivedMode ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setArchiveTarget({ ids: [...selectedIds] })}
                >
                  批量归档
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRestoreTarget({ ids: [...selectedIds] })}
                  >
                    批量恢复
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteTarget({ ids: [...selectedIds] })}
                  >
                    批量彻底删除
                  </Button>
                </>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {actionError ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{actionError}</p>
      ) : null}
      {actionSuccess ? (
        <p className="rounded-md bg-success-bg px-3 py-2 text-sm text-success">{actionSuccess}</p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      ) : null}

      {/* 文档列表 */}
      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : documents.length === 0 ? (
        <EmptyState
          title={
            tagFilter.selectedTagIds.length > 0
              ? "没有符合标签筛选的文档"
              : archivedMode
                ? "暂无已归档文档"
                : "暂无文档"
          }
          description={
            tagFilter.selectedTagIds.length > 0
              ? "尝试减少所选标签。"
              : archivedMode
                ? "归档的文档将在此显示。"
                : "上传文档后将在此显示。"
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              progress={progressMap[doc.id]}
              canManage={canManage}
              allTags={allTags}
              selected={selectedIds.has(doc.id)}
              onToggleSelect={() => toggleSelect(doc.id)}
              onReprocess={() => void handleReprocess(doc.id)}
              onArchive={() => setArchiveTarget({ ids: [doc.id] })}
              onRestore={() => setRestoreTarget({ ids: [doc.id] })}
              onHardDelete={() => setDeleteTarget({ ids: [doc.id] })}
              archivedMode={archivedMode}
              onReplaceTags={handleReplaceDocTags}
              onPreview={() => setPreviewTarget(doc)}
              onExtract={(docId) => void handleExtract(docId)}
              isExtracting={extractingIds.has(doc.id)}
            />
          ))}
        </div>
      )}

      <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />

      <Dialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        title="确认归档"
        description={
          archiveTarget
            ? `归档后默认列表隐藏，可在『已归档』视图恢复或彻底删除。确定归档选中的 ${String(archiveTarget.ids.length)} 个文档吗？`
            : ""
        }
      >
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={() => setArchiveTarget(null)}>
            取消
          </Button>
          <Button loading={actionLoading} onClick={() => void handleConfirmArchive()}>
            确认归档
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title="确认恢复"
        description={
          restoreTarget ? `确定恢复选中的 ${String(restoreTarget.ids.length)} 个文档吗？` : ""
        }
      >
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={() => setRestoreTarget(null)}>
            取消
          </Button>
          <Button loading={actionLoading} onClick={() => void handleConfirmRestore()}>
            确认恢复
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="确认彻底删除"
        description={
          deleteTarget
            ? `删除后将级联删除该文档的所有解析切分数据及原文件，数据不可恢复！确定彻底删除选中的 ${String(deleteTarget.ids.length)} 个文档吗？`
            : ""
        }
      >
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            取消
          </Button>
          <Button
            variant="destructive"
            loading={actionLoading}
            onClick={() => void handleConfirmDelete()}
          >
            彻底删除
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="上传文档"
        description="可多选文件，每份不超过 10 MB；最多同时上传 3 份，每份最多尝试 3 次。"
      >
        <div className="flex flex-col gap-4 pt-1">
          <input
            type="file"
            multiple
            onChange={(event) => {
              upload.addFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
            accept=".pdf,.md,.markdown,.txt,.docx,.csv,.xls,.xlsx,.png,.jpg,.jpeg,.webp,application/pdf,text/markdown,text/plain,image/png,image/jpeg,image/webp"
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
          <p className="text-xs text-ink-subtle">
            已上传 {upload.tasks.filter((task) => task.status === "uploaded").length} /{" "}
            {upload.tasks.length} 份
            {connectionStatus !== "idle"
              ? ` · 进度连接：${{ connecting: "连接中", connected: "已连接", reconnecting: "正在重连", polling: "轮询恢复中" }[connectionStatus]}`
              : ""}
          </p>
          <div className="max-h-96 space-y-3 overflow-y-auto">
            {upload.tasks.map((task) => (
              <div key={task.id} className="rounded-md border border-border p-3">
                <p className="break-all text-sm font-medium">{task.file.name}</p>
                <p className="mt-1 text-xs text-ink-subtle">
                  {
                    {
                      waiting: "待上传",
                      queued: "排队上传",
                      uploading: "上传中",
                      retry_waiting: "等待自动重试",
                      uploaded: "上传成功",
                      failed: "上传失败",
                      cancelled: "上传已取消",
                    }[task.status]
                  }
                  {task.attempts > 0 ? ` · 已尝试 ${String(task.attempts)} / 3 次` : ""}
                  {task.retryAt
                    ? ` · 将于 ${new Date(task.retryAt).toLocaleTimeString()} 重试`
                    : ""}
                  {task.document?.reused ? " · 已关联相同内容的原文档" : ""}
                </p>
                {task.error && <p className="mt-1 text-xs text-danger">{task.error}</p>}
                {task.document?.enabled === false && (
                  <p className="mt-1 text-xs text-ink-subtle">原文档已归档，可在已归档视图恢复。</p>
                )}
                {task.document && (
                  <DocumentProcessingSteps
                    document={task.document}
                    progress={progressMap[task.document.id]}
                  />
                )}
                <div className="mt-2 flex gap-2">
                  {(task.status === "waiting" ||
                    (task.status === "failed" && task.attempts === 0)) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => upload.removeTask(task.id)}
                    >
                      移除
                    </Button>
                  )}
                  {["queued", "uploading", "retry_waiting"].includes(task.status) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => upload.cancelUpload(task.id)}
                    >
                      取消上传
                    </Button>
                  )}
                  {["failed", "cancelled"].includes(task.status) && task.retryable && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => upload.retryUpload(task.id)}
                    >
                      重新上传
                    </Button>
                  )}
                  {task.document &&
                    (progressMap[task.document.id]?.stage ?? task.document.processStatus) ===
                      "failed" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          if (task.document) void handleReprocess(task.document.id);
                        }}
                      >
                        重新处理
                      </Button>
                    )}
                </div>
              </div>
            ))}
          </div>
          {actionError ? (
            <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{actionError}</p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setUploadOpen(false)}>
              关闭
            </Button>
            <Button
              disabled={!upload.tasks.some((task) => task.status === "waiting")}
              onClick={upload.startUpload}
            >
              开始上传
            </Button>
          </div>
        </div>
      </Dialog>

      <TagManagerDialog
        open={tagManagerOpen}
        onOpenChange={setTagManagerOpen}
        tags={allTags}
        loading={tagsLoading}
        onCreate={createTag}
        onUpdate={updateTagFn}
        onDelete={removeTag}
      />

      <DocumentPreviewDialog doc={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
}

function DocumentRow({
  doc,
  progress,
  canManage,
  allTags,
  selected,
  onToggleSelect,
  onReprocess,
  onArchive,
  onRestore,
  onHardDelete,
  archivedMode,
  onReplaceTags,
  onPreview,
  onExtract,
  isExtracting,
}: {
  doc: KnowledgeDocument;
  progress: DocumentProgressEvent | undefined;
  canManage: boolean;
  allTags: KnowledgeDocument["tags"];
  selected: boolean;
  onToggleSelect: () => void;
  onReprocess: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onHardDelete: () => void;
  archivedMode: boolean;
  onReplaceTags: (docId: string, tagIds: string[]) => Promise<void>;
  onPreview: () => void;
  onExtract: (docId: string) => void;
  isExtracting: boolean;
}) {
  const stage = progress?.stage ?? doc.processStatus;
  const tone = statusBadgeTone[stage] ?? "neutral";

  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-brand-200">
      {canManage ? (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect()}
          aria-label="选择文档"
        />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink truncate">{doc.title}</p>
        <p className="text-xs text-ink-muted mt-0.5 tabular-nums">
          {doc.sourceType} · {formatBytes(doc.fileSize)} · {doc.uploaderName}
        </p>
        {/* 已返回但此前未展示的字段：分块数 + 创建/更新时间（M5） */}
        <p className="text-xs text-ink-subtle mt-0.5 tabular-nums">
          {doc.processStatus === "completed" ? (
            <>
              父块 {doc.parentChunkCount} · 子块 {doc.childChunkCount} ·{" "}
            </>
          ) : null}
          上传 {formatDate(doc.createdAt)}
          {doc.updatedAt !== doc.createdAt ? <> · 更新 {formatDate(doc.updatedAt)}</> : null}
        </p>
        {/* 标签区：canManage 可打标签（写）；member 仅只读展示已有标签 */}
        <div className="mt-1.5">
          {canManage ? (
            <TagPickerPopover
              allTags={allTags}
              selectedTagIds={doc.tags.map((tag) => tag.id)}
              onChange={(tagIds) => onReplaceTags(doc.id, tagIds)}
            >
              <button
                type="button"
                className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-md border border-dashed border-transparent px-1 py-0.5 text-left transition-colors hover:border-border hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                aria-label="编辑标签"
              >
                {doc.tags.length > 0 ? (
                  <>
                    {doc.tags.slice(0, 3).map((tag) => (
                      <TagBadge key={tag.id} tag={tag} />
                    ))}
                    {doc.tags.length > 3 ? (
                      <span className="text-xs text-ink-subtle">+{doc.tags.length - 3}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-xs text-ink-subtle">+ 添加标签</span>
                )}
              </button>
            </TagPickerPopover>
          ) : doc.tags.length > 0 ? (
            <div className="inline-flex max-w-full flex-wrap items-center gap-1 px-1 py-0.5">
              {doc.tags.slice(0, 3).map((tag) => (
                <TagBadge key={tag.id} tag={tag} />
              ))}
              {doc.tags.length > 3 ? (
                <span className="text-xs text-ink-subtle">+{doc.tags.length - 3}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <DocumentProcessingSteps document={doc} progress={progress} />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge tone={tone}>{statusLabels[stage] ?? stage}</Badge>
        <Button variant="outline" size="sm" onClick={onPreview}>
          预览
        </Button>
        {canManage && stage === "failed" ? (
          <Button variant="secondary" size="sm" onClick={onReprocess}>
            重试
          </Button>
        ) : null}
        {canManage && !archivedMode ? (
          <Button
            variant="outline"
            size="sm"
            loading={isExtracting}
            disabled={doc.processStatus !== "completed"}
            title={doc.processStatus !== "completed" ? "仅对已解析完成的文档可提炼" : ""}
            onClick={() => onExtract(doc.id)}
          >
            AI 提炼条目
          </Button>
        ) : null}
        {canManage && !archivedMode ? (
          <Button variant="ghost" size="sm" onClick={onArchive}>
            归档
          </Button>
        ) : null}
        {canManage && archivedMode ? (
          <>
            <Button variant="outline" size="sm" onClick={onRestore}>
              恢复
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:text-danger hover:bg-danger-bg"
              onClick={onHardDelete}
            >
              彻底删除
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(value: number | null): string {
  if (value === null) return "未知大小";
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
