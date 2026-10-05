import type { DocumentUploadResult } from "@knowflow/shared";

// 上传调度独立于 React：等待重试不占网络并发，每个操作始终复用幂等键。
export type UploadStatus =
  | "waiting"
  | "queued"
  | "uploading"
  | "retry_waiting"
  | "uploaded"
  | "failed"
  | "cancelled";
export type UploadTask = {
  id: string;
  idempotencyKey: string;
  file: File;
  status: UploadStatus;
  attempts: number;
  retryable: boolean;
  retryAt?: number | undefined;
  error?: string | undefined;
  document?: DocumentUploadResult;
};

// 携带 HTTP 状态和服务端限流等待时间，以便调度器准确决定重试行为。
export class UploadRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs = 0,
    public readonly authRefreshed = false,
  ) {
    super(message);
  }
}

// 计算指数退避与随机抖动；第一次失败约等待半秒至一秒。
export function uploadRetryDelay(attempts: number, random = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return ceiling / 2 + (random() * ceiling) / 2;
}

// 仅临时网络错误、超时及明确的暂时性 HTTP 错误允许自动重试。
export function isRetryableUploadError(error: unknown): boolean {
  if (error instanceof UploadRequestError)
    return (
      [408, 429, 502, 503, 504].includes(error.status) ||
      (error.status === 401 && error.authRefreshed)
    );
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")
  );
}

type ExecuteUpload = (task: UploadTask, signal: AbortSignal) => Promise<DocumentUploadResult>;

export class UploadQueue {
  private tasks: UploadTask[] = [];
  private listeners = new Set<() => void>();
  private controllers = new Map<string, AbortController>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeCount = 0;
  private blocked = false;

  constructor(
    private readonly execute: ExecuteUpload,
    private readonly delay = uploadRetryDelay,
  ) {}

  // 外部存储订阅向 React 提供稳定的快照引用。
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // 没有状态变化时返回相同数组，避免重复渲染。
  getSnapshot = () => this.tasks;

  // 重新处理返回的新版本同步到上传列表，离开当前分页仍能重新订阅。
  updateDocument(document: DocumentUploadResult): void {
    for (const task of this.tasks) {
      if (task.document?.id === document.id) this.patch(task.id, { document });
    }
  }

  // 更新任务后通知视图，任务字段始终通过此入口修改。
  private patch(id: string, patch: Partial<UploadTask>): void {
    this.tasks = this.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task));
    this.listeners.forEach((listener) => listener());
  }

  // 新增文件时预校验格式和大小；每份选择生成独立幂等键。
  add(files: File[]): void {
    const extensions = /\.(pdf|md|markdown|txt|docx|csv|xlsx|xls|png|jpg|jpeg|webp)$/i;
    const added = files.map((file): UploadTask => {
      const id = crypto.randomUUID();
      const error =
        file.size === 0
          ? "文件为空"
          : file.size > 10 * 1024 * 1024
            ? "文件不能超过 10 MB"
            : !extensions.test(file.name)
              ? "不支持的文件格式"
              : undefined;
      return {
        id,
        idempotencyKey: id,
        file,
        status: error ? "failed" : "waiting",
        attempts: 0,
        retryable: false,
        ...(error ? { error } : {}),
      };
    });
    this.tasks = [...this.tasks, ...added];
    this.listeners.forEach((listener) => listener());
  }

  // 点击开始仅将待上传任务入队，已成功任务不会重复发送。
  start(): void {
    this.blocked = false;
    this.tasks = this.tasks.map((task) =>
      task.status === "waiting" ? { ...task, status: "queued" } : task,
    );
    this.listeners.forEach((listener) => listener());
    this.pump();
  }

  // 手动重试开启新一轮三次尝试，但始终保留原幂等键。
  retry(id: string): void {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task || !["failed", "cancelled"].includes(task.status) || !task.retryable) return;
    this.blocked = false;
    this.patch(id, { status: "queued", attempts: 0, error: undefined, retryAt: undefined });
    this.pump();
  }

  // 取消等待或在途请求，不代表服务端已撤销保存。
  cancel(id: string): void {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task || task.status === "uploaded") return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.patch(id, { status: "cancelled", retryable: true, retryAt: undefined });
    this.controllers.get(id)?.abort();
  }

  // 只有尚未开始的文件可以移除；在途文件使用取消以保留重试身份。
  remove(id: string): void {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task || (task.status !== "waiting" && !(task.status === "failed" && task.attempts === 0)))
      return;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    this.listeners.forEach((listener) => listener());
  }

  // 页面离开时清理定时器和请求，避免后台重试与组件泄漏。
  dispose(): void {
    this.blocked = true;
    for (const task of this.tasks) {
      if (["queued", "uploading", "retry_waiting"].includes(task.status)) this.cancel(task.id);
    }
  }

  // 只统计正在执行的 HTTP 请求，最多三个；退避等待释放位置。
  private pump(): void {
    while (!this.blocked && this.activeCount < 3) {
      const task = this.tasks.find(
        (entry) => entry.status === "queued" && !this.controllers.has(entry.id),
      );
      if (!task) return;
      this.activeCount += 1;
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      this.patch(task.id, {
        status: "uploading",
        attempts: task.attempts + 1,
        error: undefined,
        retryAt: undefined,
      });
      void this.run({ ...task, attempts: task.attempts + 1 }, controller);
    }
  }

  // 完成一次请求，失败时按类型重排任务，最后立即填补空闲位置。
  private async run(task: UploadTask, controller: AbortController): Promise<void> {
    try {
      const document = await this.execute(task, controller.signal);
      if (!controller.signal.aborted)
        this.patch(task.id, { status: "uploaded", document, retryable: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "上传失败";
      const retryable = isRetryableUploadError(error);
      if (
        error instanceof UploadRequestError &&
        (error.status === 403 || (error.status === 401 && !error.authRefreshed))
      ) {
        this.blocked = true;
        // 权限失效暂停尚未开始的任务，避免页面一直显示正在上传。
        for (const waiting of this.tasks) {
          if (["queued", "retry_waiting"].includes(waiting.status)) {
            clearTimeout(this.timers.get(waiting.id));
            this.timers.delete(waiting.id);
            this.patch(waiting.id, {
              status: "failed",
              error: message,
              retryable: true,
              retryAt: undefined,
            });
          }
        }
      }
      if (retryable && task.attempts < 3) {
        const delay = Math.max(
          this.delay(task.attempts),
          error instanceof UploadRequestError ? error.retryAfterMs : 0,
        );
        this.patch(task.id, {
          status: "retry_waiting",
          error: message,
          retryable: true,
          retryAt: Date.now() + delay,
        });
        this.timers.set(
          task.id,
          setTimeout(() => {
            this.timers.delete(task.id);
            this.patch(task.id, { status: "queued", retryAt: undefined });
            this.pump();
          }, delay),
        );
      } else {
        // 校验错误需要修改文件；其他失败可在服务恢复或重新登录后手动重试。
        const manualRetry = !(
          error instanceof UploadRequestError &&
          [400, 404, 409, 413, 415, 422].includes(error.status)
        );
        this.patch(task.id, { status: "failed", error: message, retryable: manualRetry });
      }
    } finally {
      this.controllers.delete(task.id);
      this.activeCount -= 1;
      this.pump();
    }
  }
}
