"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../../../components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../../components/ui/alert-dialog";
import { apiRequest, emptyObjectSchema } from "../../../../lib/api";
import { translateApiError } from "../../../../lib/api-error";

// 呈现知识库设置页中的危险操作，并处理知识库删除后的返回路径。
export function TabSettings({
  knowledgeBaseId,
  kbName,
}: {
  knowledgeBaseId: string;
  kbName: string;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const router = useRouter();

  // 删除知识库并在成功后返回知识库列表。
  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiRequest(`/knowledge-bases/${knowledgeBaseId}`, emptyObjectSchema, {
        method: "DELETE",
      });
      setDeleteOpen(false);
      router.push("/knowledge-bases");
    } catch (error) {
      setDeleteError(
        error instanceof Error ? translateApiError(error.message) : "删除失败",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex max-w-2xl flex-col gap-4 rounded-lg border border-danger/40 bg-danger-bg/30 p-5">
        <h3 className="text-base font-medium text-danger">危险区域</h3>
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-ink-muted">
            删除知识库后将移入回收站，不再参与检索与问答；可在知识库列表的回收站中恢复。
          </p>
          <Button
            type="button"
            variant="destructive"
            className="shrink-0"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            删除知识库
          </Button>
        </div>
      </section>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteOpen(false);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除知识库</AlertDialogTitle>
            <AlertDialogDescription>
              删除后「{kbName}」将被移入回收站，不再参与检索、问答与 Agent 调用。你可以在知识库列表的回收站中恢复它。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
