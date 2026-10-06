// Markdown/OCR 的语法树、纯文本段落与表格转换为统一结构块，来源信息始终独立于展示文本。
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { RootContent, TableRow as MarkdownTableRow } from "mdast";
import type {
  ContentSource,
  ParsedContentBlock,
  StructuredTable,
  TableRow,
} from "../document-blocks.js";

// 部分视觉模型会给整篇响应套 Markdown 围栏；只在 OCR 输出入口移除此包装，原生 MD 的代码节点不受影响。
export function normalizeOcrMarkdown(text: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
  const only = tree.children[0];
  if (
    tree.children.length === 1 &&
    only?.type === "code" &&
    ["markdown", "md", "gfm"].includes(only.lang?.toLowerCase() ?? "")
  )
    return only.value;
  return text;
}

// 去除内部分页标记；页码应由解析器参数传入，用户正文不会被当成页码指令。
export function parseMarkdownBlocks(
  markdown: string,
  pageNumbers: number[] = [],
  idPrefix = "markdown",
): ParsedContentBlock[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  return tree.children.flatMap((node, index) => {
    if (
      node.type === "definition" ||
      (node.type === "html" && /^<!-- KNOWFLOW_PAGE_BREAK[: >]/.test(node.value))
    )
      return [];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return [];
    const blockId = `${idPrefix}:${String(index)}`;
    const source: ContentSource = {
      blockId,
      pageNumbers: [...pageNumbers],
      precision: "block",
      ...(node.position === undefined
        ? {}
        : { lineStart: node.position.start.line, lineEnd: node.position.end.line }),
    };
    const kind = markdownNodeKind(node);
    let text = markdown.slice(start, end);
    if (node.type === "heading") {
      // Setext 和 ATX 标题使用同一展示格式，标题路径不包含下划线式分隔行。
      const title = text
        .replace(/^#{1,6}\s+/, "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .replace(/\r?\n[ \t]*[=-]+[ \t]*$/, "");
      text = `${"#".repeat(node.depth)} ${title}`;
    }
    // 缩进代码也统一为围栏代码，避免下一阶段丢失缩进后误识别为标题。
    if (node.type === "code") {
      let backticks = 3;
      let tildes = 3;
      // 选择较短且不与正文冲突的围栏，避免巨量匹配展开为函数参数耗尽调用栈。
      for (const match of node.value.matchAll(/`+/g))
        backticks = Math.max(backticks, match[0].length + 1);
      for (const match of node.value.matchAll(/~+/g))
        tildes = Math.max(tildes, match[0].length + 1);
      const fence = backticks <= tildes ? "`".repeat(backticks) : "~".repeat(tildes);
      text = `${fence}${node.lang ?? ""}${node.meta === null || node.meta === undefined ? "" : ` ${node.meta}`}\n${node.value}\n${fence}`;
    }
    const firstRow = node.type === "table" ? node.children[0] : undefined;
    const table =
      node.type === "table" && firstRow !== undefined
        ? {
            header: markdownTableRow(firstRow, markdown, source, `${blockId}:header`),
            rows: node.children
              .slice(1)
              .map((row, rowIndex) =>
                markdownTableRow(row, markdown, source, `${blockId}:row:${String(rowIndex + 1)}`),
              ),
          }
        : undefined;
    return [
      {
        kind,
        markdown: text,
        level: node.type === "heading" ? node.depth : null,
        pageNumbers: [...pageNumbers],
        sources: [source],
        ...(table === undefined ? {} : { table }),
      },
    ];
  });
}

// 从 AST 类型识别语义节点，代码中的 #、编号和竖线都不参与标题或表格判断。
function markdownNodeKind(node: RootContent): ParsedContentBlock["kind"] {
  if (node.type === "heading") return "heading";
  if (node.type === "table") return "table";
  if (node.type === "code") return "code";
  if (node.type === "list") return "list";
  if (node.type === "paragraph") return "paragraph";
  return "other";
}

// 保留表格的原始内联语法与逐行来源，使用 AST 单元格避免按未转义竖线误拆。
function markdownTableRow(
  node: MarkdownTableRow,
  text: string,
  source: ContentSource,
  id: string,
): TableRow {
  const rowSource: ContentSource = {
    ...source,
    precision: "row",
    ...(node.position === undefined
      ? {}
      : { lineStart: node.position.start.line, lineEnd: node.position.end.line }),
  };
  return {
    id,
    sources: [rowSource],
    cells: node.children.map((cell) => ({
      // GFM 的 cell.position 包含相邻竖线，真正内容范围来自首尾内联节点。
      text:
        cell.children.length === 0
          ? ""
          : text
              .slice(
                cell.children[0]?.position?.start.offset,
                cell.children.at(-1)?.position?.end.offset,
              )
              .trim(),
      sources: [rowSource],
    })),
  };
}

// TXT 只按空行组织段落，不把代码注释、中文序号和 Markdown 标记猜测为标题。
export function parsePlainTextBlocks(text: string): ParsedContentBlock[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .split("\n");
  const blocks: ParsedContentBlock[] = [];
  let start = 0;
  // 保存非空段落并保留其缩进和原始行号。
  function flush(end: number): void {
    const markdown = lines.slice(start, end).join("\n");
    if (markdown.trim().length === 0) return;
    blocks.push({
      kind: "paragraph",
      textFormat: "plain",
      markdown,
      level: null,
      pageNumbers: [],
      sources: [
        {
          blockId: `text:${String(blocks.length)}`,
          pageNumbers: [],
          precision: "block",
          lineStart: start + 1,
          lineEnd: end,
        },
      ],
    });
  }
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      flush(index);
      start = index + 1;
    }
  });
  flush(lines.length);
  return blocks;
}

// 以 BOM 优先、严格 UTF-8 次之的方式解码，旧中文文本才使用 GB18030 兜底。
export function decodeText(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(buffer);
  }
}

// 统一转义表格单元格；保留换行含义，绝不截断 Markdown 行来伪造表格。
export function renderTableRow(row: TableRow): string {
  return `| ${row.cells.map((cell) => cell.text.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`;
}

// 为每个表格片段生成完整表头、分隔行及数据行。
export function renderTable(table: StructuredTable): string {
  return [
    renderTableRow(table.header),
    `| ${table.header.cells.map(() => "---").join(" | ")} |`,
    ...table.rows.map(renderTableRow),
  ].join("\n");
}

// 对解析器未提供结构化单元格的表格使用 GFM AST 补齐，来源精度保持为原节点范围。
export function ensureBlockSources(block: ParsedContentBlock, index: number): ParsedContentBlock {
  const sources = block.sources ?? [
    {
      blockId: `node:${String(index)}`,
      pageNumbers: [...block.pageNumbers],
      precision: "block" as const,
    },
  ];
  if (block.kind !== "table" || block.table !== undefined) return { ...block, sources };
  const table = parseMarkdownBlocks(block.markdown).find(
    (candidate) => candidate.table !== undefined,
  )?.table;
  if (table === undefined) throw new Error("结构化表格缺少有效表格行");
  // 旧适配器只有节点页码，不声称每一行都能精确映射到某一页。
  const withSources = (row: TableRow): TableRow => ({
    ...row,
    sources,
    cells: row.cells.map((cell) => ({ ...cell, sources })),
  });
  return {
    ...block,
    sources,
    table: { header: withSources(table.header), rows: table.rows.map(withSources) },
  };
}
