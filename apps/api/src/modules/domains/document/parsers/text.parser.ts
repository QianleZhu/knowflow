// Markdown 与纯文本解析。
import { toParsedDocument } from "./cleaner.js";
import type { ParserContext } from "./types.js";
import { parseDoclingDocument } from "./docling.parser.js";

// 按 UTF-8 解码并使用统一清洗规则生成正文。
export function parseTextDocument(buffer: Buffer, context: ParserContext) {
  if (context.sourceType === "markdown") return parseDoclingDocument(buffer, "md");
  return toParsedDocument(buffer.toString("utf8"), "plain-text", {}, "text");
}
