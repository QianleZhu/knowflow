// Markdown 与纯文本解析。
import { removeControlCharacters, toParsedDocument } from "./cleaner.js";
import type { ParserContext } from "./types.js";
import { decodeText, parsePlainTextBlocks } from "./structured-content.js";
import { parseMarkdownDocument } from "./markdown.parser.js";

// 按 UTF-8 解码并使用统一清洗规则生成正文。
export async function parseTextDocument(buffer: Buffer, context: ParserContext) {
  const text = decodeText(buffer);
  if (context.sourceType === "markdown") return parseMarkdownDocument(text);
  const parsed = await toParsedDocument(text, "plain-text", {}, "plain");
  return {
    ...parsed,
    structuredBlocks: parsePlainTextBlocks(removeControlCharacters(text.replace(/\r\n?/g, "\n"))),
  };
}
