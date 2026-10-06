// 原生 Markdown AST 解析与图片原位描述；复用既有下载白名单，不向 Docling 转换 Markdown。
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Definition } from "mdast";
import { prepareMarkdownImages } from "./markdown-images.js";
import { parseMarkdownBlocks } from "./structured-content.js";
import { toParsedDocument } from "./cleaner.js";
import {
  describeImageWithVision,
  newVisionStats,
  pushUniqueWarning,
  visionStatsMetadata,
} from "./vision-ocr.js";
import type { ParsedDocument } from "./types.js";

// 语法树提供节点类型和原始行号，图片替换不会影响其他节点位置。
export async function parseMarkdownDocument(
  markdown: string,
  describe = describeImageWithVision,
): Promise<ParsedDocument> {
  const prepared = await prepareMarkdownImages(markdown);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(prepared.markdown);
  const definitions = new Map<string, Definition>();
  const images: RootContent[] = [];
  // 收集真实图片节点，代码中的图片链接不执行下载或识别。
  function visit(node: Root | RootContent): void {
    if (node.type === "definition") definitions.set(node.identifier.toUpperCase(), node);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if ("children" in node) node.children.forEach(visit);
  }
  visit(tree);
  const stats = newVisionStats();
  const cache = new Map<string, string>();
  const replacements: { start: number; end: number; text: string }[] = [];
  for (const node of images) {
    if (node.type !== "image" && node.type !== "imageReference") continue;
    const source =
      node.type === "image" ? node.url : definitions.get(node.identifier.toUpperCase())?.url;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    let description = node.alt ?? "";
    const data = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(source ?? "");
    if (data?.[1] !== undefined && data[1].length <= 28 * 1024 * 1024) {
      const bytes = Buffer.from(data[1], "base64");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const cached = cache.get(hash);
      if (cached !== undefined) description = cached;
      else {
        try {
          // MIME 和装饰图判断使用实际图片字节，不能相信 data URI 声明。
          const size = imageSize(bytes);
          description =
            (await describe(
              {
                buffer: bytes,
                mimeType: size.type === "jpg" ? "image/jpeg" : `image/${size.type ?? "png"}`,
                width: size.width,
                height: size.height,
                sourceLabel: "Markdown 图片",
                skipDecorative: true,
              },
              stats,
            )) ?? description;
        } catch {
          pushUniqueWarning(stats, "markdown_image_invalid");
        }
        cache.set(hash, description);
      }
    } else pushUniqueWarning(stats, "markdown_image_unavailable");
    // 图片所在的表格单元格不可引入裸换行或竖线，避免 OCR 输出破坏表格行。
    const inTable = tree.children.some(
      (candidate) =>
        candidate.type === "table" &&
        (candidate.position?.start.offset ?? Infinity) <= start &&
        (candidate.position?.end.offset ?? -1) >= end,
    );
    replacements.push({
      start,
      end,
      text: inTable
        ? description.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|")
        : description,
    });
  }
  // 先生成节点来源，再在各节点内部替换图片，OCR 增加的行不改写原始行坐标。
  const structuredBlocks = parseMarkdownBlocks(prepared.markdown);
  for (const block of structuredBlocks) {
    const source = block.sources?.[0];
    const node = tree.children.find(
      (candidate) =>
        candidate.position?.start.line === source?.lineStart &&
        candidate.position?.end.line === source?.lineEnd,
    );
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    let text = prepared.markdown.slice(start, end);
    for (const replacement of replacements
      .filter((item) => item.start >= start && item.end <= end)
      .sort((a, b) => b.start - a.start)) {
      text =
        text.slice(0, replacement.start - start) +
        replacement.text +
        text.slice(replacement.end - start);
    }
    if (node?.type === "heading") {
      const title = text
        .replace(/^#{1,6}\s+/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .replace(/\r?\n[ \t]*[=-]+[ \t]*$/, "");
      block.markdown = `${"#".repeat(node.depth)} ${title}`;
    } else if (node?.type !== "code") block.markdown = text;
    // 表格中的图片描述重新通过 AST 得到单元格文本，并继承原来的行来源。
    if (
      block.table !== undefined &&
      replacements.some((item) => item.start >= start && item.end <= end)
    ) {
      const table = parseMarkdownBlocks(text).find((item) => item.table !== undefined)?.table;
      if (table !== undefined) {
        const originalRows = [block.table.header, ...block.table.rows];
        [table.header, ...table.rows].forEach((row, index) => {
          row.sources = originalRows[index]?.sources ?? block.sources ?? [];
          row.cells.forEach((cell) => {
            cell.sources = row.sources;
          });
        });
        block.table = table;
      }
    }
  }
  // 展示正文保留定义式链接；结构块保留 AST 节点来源，不因替换图片而重新定位行号。
  let text = prepared.markdown;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  const parsed = await toParsedDocument(text, "remark", {
    ...visionStatsMetadata(stats),
    parserWarnings: prepared.warnings,
  });
  return { ...parsed, structuredBlocks };
}
