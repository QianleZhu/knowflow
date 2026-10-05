// 文档章节与父子片段切分。
import {
  PAGE_BREAK_MARKER_PREFIX,
  detectHeadingLine,
  isMarkdownTableLine,
  isListLine,
  pageMarkerNumber,
  stripPageMarkers,
} from "./document-text-structure.js";

const PARENT_TARGET_CHARS = 2600;

const PARENT_MAX_CHARS = 4000;

const CHILD_TARGET_CHARS = 900;

const CHILD_OVERLAP_CHARS = 120;

export const CHUNKER_VERSION = "semantic-chunker-v1";

type BoundaryType = "heading" | "table" | "list" | "paragraph" | "sentence" | "length";

type ParentChunkInput = {
  title: string | null;
  content: string;
  headingPath: string[];
  boundaryType: BoundaryType;
  pageStart: number | null;
  pageEnd: number | null;
  lines: PageAwareLine[];
};

type ChildChunkInput = {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  boundaryType: BoundaryType;
};

type PageAwareLine = {
  text: string;
  page: number | null;
};

type TextBlock = {
  content: string;
  boundaryType: BoundaryType;
  lines: PageAwareLine[];
};

type SemanticParentPiece = {
  content: string;
  boundaryType: BoundaryType;
  pageStart: number | null;
  pageEnd: number | null;
};

// 按章节和语义边界生成带标题路径与页码的父片段。
export function splitParentChunks(text: string): ParentChunkInput[] {
  const sections = splitHeadingSections(text);
  const parents: ParentChunkInput[] = [];

  for (const section of sections) {
    const pieces = splitSemanticParentLines(section.lines);
    pieces.forEach((piece, index) => {
      parents.push({
        title:
          index === 0
            ? section.title
            : section.title === null
              ? null
              : `${section.title} (${String(index + 1)})`,
        content: piece.content,
        headingPath: section.headingPath,
        boundaryType: index === 0 && section.title !== null ? "heading" : piece.boundaryType,
        pageStart: piece.pageStart,
        pageEnd: piece.pageEnd,
        lines: [],
      });
    });
  }

  return parents;
}

// 按中英文标题层级组织章节。
function splitHeadingSections(text: string): ParentChunkInput[] {
  const lines = toPageAwareLines(text);
  const sections: ParentChunkInput[] = [];
  let currentTitle: string | null = null;
  let currentHeadingPath: string[] = [];
  let currentLines: PageAwareLine[] = [];

  function flush(): void {
    const content = currentLines
      .map((line) => line.text)
      .join("\n")
      .trim();
    if (content.length === 0) {
      return;
    }
    const range = pageRange(currentLines);
    sections.push({
      title: currentTitle,
      headingPath: currentHeadingPath,
      content,
      boundaryType: currentTitle === null ? inferBoundaryType(content) : "heading",
      pageStart: range.pageStart,
      pageEnd: range.pageEnd,
      lines: [...currentLines],
    });
    currentLines = [];
  }

  for (const line of lines) {
    const heading = detectHeadingLine(line.text);
    if (heading !== null) {
      flush();
      const { level, title } = heading;
      currentHeadingPath = [...currentHeadingPath.slice(0, level - 1), title];
      currentTitle = title;
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections.length > 0
    ? sections
    : splitSemanticParentLines(toPageAwareLines(stripPageMarkers(text))).map((piece, index) => ({
        title: index === 0 ? null : `Part ${String(index + 1)}`,
        headingPath: [],
        boundaryType: piece.boundaryType,
        pageStart: piece.pageStart,
        pageEnd: piece.pageEnd,
        content: piece.content,
        lines: [],
      }));
}

// 生成带重叠上下文的子片段。
export function splitChildChunks(content: string): ChildChunkInput[] {
  return splitByLength(content, CHILD_TARGET_CHARS, CHILD_OVERLAP_CHARS).map((chunk, index) => ({
    content: chunk,
    chunkIndex: index,
    tokenCount: estimateTokenCount(chunk),
    boundaryType: inferBoundaryType(chunk),
  }));
}

// 按表格、列表和段落边界拆分父片段。
function splitSemanticParentLines(lines: PageAwareLine[]): SemanticParentPiece[] {
  const blocks = splitTextBlocks(lines);
  const chunks: SemanticParentPiece[] = [];
  let currentLines: PageAwareLine[] = [];

  function pushCurrent(): void {
    const content = currentLines
      .map((line) => line.text)
      .join("\n")
      .trim();
    if (content.length > 0) {
      const range = pageRange(currentLines);
      chunks.push({
        content,
        boundaryType: inferBoundaryType(content),
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
      });
    }
    currentLines = [];
  }

  for (const block of blocks) {
    const pieces =
      block.content.length > PARENT_MAX_CHARS
        ? splitBlockBySentenceThenLength(block, PARENT_TARGET_CHARS, PARENT_MAX_CHARS)
        : [block.lines];
    for (const piece of pieces) {
      if (currentLines.length === 0) {
        currentLines = piece;
        continue;
      }
      const currentContent = currentLines
        .map((line) => line.text)
        .join("\n")
        .trim();
      const pieceContent = piece
        .map((line) => line.text)
        .join("\n")
        .trim();
      const next = `${currentContent}\n\n${pieceContent}`;
      if (
        next.length <= PARENT_TARGET_CHARS ||
        currentContent.length < Math.floor(PARENT_TARGET_CHARS * 0.65)
      ) {
        currentLines = [...currentLines, { text: "", page: null }, ...piece];
      } else {
        pushCurrent();
        currentLines = piece;
      }
    }
  }
  pushCurrent();

  return chunks.flatMap((chunk) =>
    chunk.content.length <= PARENT_MAX_CHARS
      ? [chunk]
      : splitByLength(chunk.content, PARENT_MAX_CHARS, 0).map((content) => ({
          content,
          boundaryType: inferBoundaryType(content),
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        })),
  );
}

// 将逐行文本聚合为语义块。
function splitTextBlocks(lines: PageAwareLine[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let currentLines: PageAwareLine[] = [];
  let currentType: BoundaryType | null = null;
  let currentPage: number | null | undefined;

  function flush(): void {
    const text = currentLines
      .map((line) => line.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      blocks.push({
        content: text,
        boundaryType: currentType ?? "paragraph",
        lines: [...currentLines],
      });
    }
    currentLines = [];
    currentType = null;
    currentPage = undefined;
  }

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    const type = classifyBlockLine(trimmed);
    if (
      currentType !== null &&
      (type !== currentType ||
        type === "heading" ||
        currentType === "paragraph" ||
        line.page !== currentPage)
    ) {
      flush();
    }
    currentType = type;
    currentPage = line.page;
    currentLines.push(line);
  }
  flush();

  return blocks;
}

// 先按句子拆分超长语义块，再按长度兜底。
function splitBlockBySentenceThenLength(
  block: TextBlock,
  targetChars: number,
  maxChars: number,
): PageAwareLine[][] {
  const sentences = block.content.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [block.content];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const next = current.length === 0 ? trimmed : `${current}${trimmed}`;
    if (next.length <= targetChars || current.length < Math.floor(targetChars * 0.5)) {
      current = next;
    } else {
      chunks.push(current);
      current = trimmed;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  const range = pageRange(block.lines);
  return chunks.flatMap((chunk) =>
    chunk.length <= maxChars
      ? [[{ text: chunk, page: range.pageStart }]]
      : splitByLength(chunk, maxChars, 0).map((content) => [
          { text: content, page: range.pageStart },
        ]),
  );
}

// 识别标题、表格、列表和普通段落。
function classifyBlockLine(line: string): BoundaryType {
  if (detectHeadingLine(line) !== null) {
    return "heading";
  }
  if (isMarkdownTableLine(line)) {
    return "table";
  }
  if (isListLine(line)) {
    return "list";
  }
  return "paragraph";
}

// 根据首行推断片段的语义边界。
function inferBoundaryType(content: string): BoundaryType {
  const firstLine = content.trim().split("\n")[0] ?? "";
  return classifyBlockLine(firstLine);
}

// 解析页码标记并为正文行附加页码。
function toPageAwareLines(text: string): PageAwareLine[] {
  const lines: PageAwareLine[] = [];
  let currentPage: number | null = text.includes(PAGE_BREAK_MARKER_PREFIX) ? 1 : null;
  for (const line of text.split("\n")) {
    const marker = pageMarkerNumber(line);
    if (marker !== null) {
      currentPage = marker;
      continue;
    }
    lines.push({ text: line, page: currentPage });
  }
  return lines;
}

// 计算正文行覆盖的起止页码。
function pageRange(lines: PageAwareLine[]): { pageStart: number | null; pageEnd: number | null } {
  const pages = lines.map((line) => line.page).filter((page): page is number => page !== null);
  if (pages.length === 0) {
    return { pageStart: null, pageEnd: null };
  }
  return {
    pageStart: Math.min(...pages),
    pageEnd: Math.max(...pages),
  };
}

// 按目标长度拆分正文并保留指定重叠。
function splitByLength(text: string, targetChars: number, overlapChars: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= targetChars) {
    return normalized.length === 0 ? [] : [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + targetChars, normalized.length);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const newline = normalized.lastIndexOf("\n\n", hardEnd);
      const sentence = normalized.lastIndexOf("\u3002", hardEnd);
      const space = normalized.lastIndexOf(" ", hardEnd);
      const candidate = Math.max(newline, sentence, space);
      if (candidate > start + Math.floor(targetChars * 0.55)) {
        end = candidate + 1;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) {
      break;
    }
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

// 估算片段的 token 数量。
function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}
