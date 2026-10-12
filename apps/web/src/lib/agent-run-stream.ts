export type SseFrame = { data: string | null; id: string | null };

// 缓存任意网络分片并按 SSE 空行边界解析 data、id 与心跳注释。
export class SseFrameDecoder {
  private buffer = "";

  // 加入新网络分片并返回已完整到达的 SSE 帧。
  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    while (this.buffer.length > 0) {
      // 先匹配完整 CRLF 空行，避免将其中的裸 CR 与后续 LF 拆成两个分隔符。
      const boundary = /\r\n\r\n|\n\n|\r\r/u.exec(this.buffer);
      if (boundary === null) break;
      const frameText = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      frames.push(this.parseFrame(frameText));
    }
    return frames;
  }

  // 在 EOF 时按 SSE 规则派发最后一个没有空行终止符的完整缓冲帧。
  flush(): SseFrame[] {
    if (this.buffer.length === 0) return [];
    const frame = this.parseFrame(this.buffer);
    this.buffer = "";
    return [frame];
  }

  // 解析一个 SSE 帧，忽略心跳注释并保留多行 data 的换行。
  private parseFrame(frame: string): SseFrame {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of frame.split(/\r\n|\n|\r/u)) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (field === "data") data.push(value);
      if (field === "id" && !value.includes("\0")) id = value;
    }
    return { data: data.length === 0 ? null : data.join("\n"), id };
  }
}

// 用带抖动的指数退避分散并限制 SSE 重连流量。
export function getAgentRunReconnectDelay(attempt: number, random = Math.random()): number {
  const exponentialDelay = Math.min(15_000, 2_000 * 2 ** Math.max(0, attempt));
  return Math.round(exponentialDelay * (0.5 + Math.max(0, Math.min(1, random)) * 0.5));
}

// 判断 Worker 已经写入不会再变化的运行终态。
export function isAgentRunTerminal(status: string): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}
