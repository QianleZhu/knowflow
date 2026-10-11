// 定义与浏览器动画帧对齐的流式增量批处理器。
export type AnimationFrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (frameId: number) => void;
};

// 把同一条回答的多个 delta 合并后再交给 React，避免每个 token 都更新消息状态。
export class StreamDeltaBuffer {
  private pending: { messageId: string; delta: string } | null = null;
  private frameId: number | null = null;
  private disposed = false;

  constructor(
    private readonly onFlush: (messageId: string, delta: string) => void,
    private readonly scheduler: AnimationFrameScheduler = {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (frameId) => cancelAnimationFrame(frameId),
    },
  ) {}

  // 缓存增量并确保同一帧最多安排一次状态更新。
  append(messageId: string, delta: string): void {
    if (this.disposed || delta.length === 0) return;
    if (this.pending !== null && this.pending.messageId !== messageId) this.flush();
    const pending = this.pending;
    this.pending ??= { messageId, delta };
    if (pending !== null) {
      this.pending = { messageId, delta: `${pending.delta}${delta}` };
    }
    this.frameId ??= this.scheduler.request(() => {
      this.frameId = null;
      this.flush();
    });
  }

  // 立即提交尚未到下一帧的内容，保证完成或停止时不丢最后一批 delta。
  flush(): void {
    if (this.frameId !== null) {
      this.scheduler.cancel(this.frameId);
      this.frameId = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) this.onFlush(pending.messageId, pending.delta);
  }

  // 丢弃切换会话或卸载后不再属于当前视图的增量。
  clear(): void {
    if (this.frameId !== null) this.scheduler.cancel(this.frameId);
    this.frameId = null;
    this.pending = null;
  }

  // 释放批处理器并阻止过期动画帧继续触发状态更新。
  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
