// Markdown 与纯文本解析。
import { toParsedDocument } from "./cleaner.js";

// 按 UTF-8 解码并使用统一清洗规则生成正文。
export function parseTextDocument(buffer: Buffer) {
  return toParsedDocument(buffer.toString("utf8"), "plain-text");
}
