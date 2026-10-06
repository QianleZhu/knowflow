// 文档章节与父子片段切分。
import {
  hasPageMarkers,
  detectHeadingLine,
  isMarkdownTableLine,
  isMarkdownTableSeparatorLine,
  isListLine,
  pageMarkerNumber,
  stripPageMarkers,
} from "./document-text-structure.js";
import type { ParsedContentBlock } from "./document-blocks.js";

const PARENT_TARGET_CHARS = 2600;

const PARENT_MAX_CHARS = 4000;

const CHILD_TARGET_CHARS = 900;

const CHILD_OVERLAP_CHARS = 120;

export const CHUNKER_VERSION = "semantic-chunker-v4";

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
export function splitParentChunks(
  text: string,
  structuredBlocks?: ParsedContentBlock[],
): ParentChunkInput[] {
  // 调用方显式提供结构块时固定走结构化切分，空数组不能被当作 Markdown 回退信号。
  if (structuredBlocks !== undefined) {
    if (structuredBlocks.length === 0) throw new Error("结构化切分缺少文档树节点");
    return splitStructuredParentChunks(structuredBlocks);
  }
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

// 依 Docling 节点类型、标题层级和 provenance 页码生成父块。
function splitStructuredParentChunks(blocks: ParsedContentBlock[]): ParentChunkInput[] {
  type Section = {
    title: string | null;
    headingPath: string[];
    heading: ParsedContentBlock | null;
    blocks: ParsedContentBlock[];
  };
  const sections: Section[] = [];
  let headingPath: string[] = [];
  let current: Section = { title: null, headingPath: [], heading: null, blocks: [] };

  // 保存当前标题下已经收集到的节点。
  function flushSection(): void {
    if (current.heading !== null || current.blocks.length > 0) sections.push(current);
    current = { title: null, headingPath, heading: null, blocks: [] };
  }

  for (const block of blocks) {
    const markdown = block.markdown.trim();
    if (markdown.length === 0) continue;
    if (block.kind === "heading") {
      flushSection();
      // 结构块层级由 Docling 适配层归一化；缺少层级时才从 Markdown 标记兜底。
      const level = Math.min(
        6,
        Math.max(1, block.level ?? detectHeadingLine(markdown)?.level ?? 1),
      );
      const title = detectHeadingLine(markdown)?.title ?? markdown.replace(/^#{1,6}\s+/, "").trim();
      headingPath = [...headingPath.slice(0, level - 1), title];
      current = { title, headingPath: [...headingPath], heading: block, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  flushSection();

  return sections.flatMap((section) => splitStructuredSection(section));
}

// 在同一标题范围内合并相邻节点，页码取标题和正文节点 provenance 的范围。
function splitStructuredSection(section: {
  title: string | null;
  headingPath: string[];
  heading: ParsedContentBlock | null;
  blocks: ParsedContentBlock[];
}): ParentChunkInput[] {
  const headingText = section.heading?.markdown.trim() ?? "";
  const atoms = section.blocks.flatMap((block) => splitStructuredBlock(block));

  const parents: ParentChunkInput[] = [];
  let currentAtoms: SemanticParentPiece[] = [];

  // 组合当前父块内容，并在多段之间保留 Markdown 空行。
  function currentContent(atomsToJoin: SemanticParentPiece[]): string {
    const body = atomsToJoin
      .map((atom) => atom.content)
      .join("\n\n")
      .trim();
    return [headingText, body].filter((part) => part.length > 0).join("\n\n");
  }

  // 汇总当前父块实际节点覆盖的页码。
  function flush(): void {
    if (currentAtoms.length === 0 && headingText.length === 0) return;
    const content = currentContent(currentAtoms);
    const pages = [
      ...(section.heading?.pageNumbers ?? []),
      ...currentAtoms.flatMap((atom) => [atom.pageStart, atom.pageEnd]),
    ].filter((page): page is number => page !== null);
    const firstAtom = currentAtoms[0];
    parents.push({
      title: section.title,
      content,
      headingPath: section.headingPath,
      boundaryType:
        parents.length === 0 && section.heading !== null
          ? "heading"
          : (firstAtom?.boundaryType ?? "heading"),
      pageStart: pages.length === 0 ? null : Math.min(...pages),
      pageEnd: pages.length === 0 ? null : Math.max(...pages),
      lines: [],
    });
    currentAtoms = [];
  }

  for (const atom of atoms) {
    if (currentAtoms.length === 0) {
      currentAtoms = [atom];
      continue;
    }
    const nextAtoms = [...currentAtoms, atom];
    const nextContent = currentContent(nextAtoms);
    if (nextContent.length <= PARENT_TARGET_CHARS) {
      currentAtoms = nextAtoms;
    } else {
      flush();
      currentAtoms = [atom];
    }
  }
  flush();
  return parents;
}

// 保留结构节点的语义格式；仅对超长单节点做句子、表格行或代码行切分。
function splitStructuredBlock(block: ParsedContentBlock): SemanticParentPiece[] {
  const content = block.markdown.trim();
  const pages = [...new Set(block.pageNumbers)].filter(
    (page) => Number.isSafeInteger(page) && page > 0,
  );
  const boundaryType: BoundaryType =
    block.kind === "heading"
      ? "heading"
      : block.kind === "table"
        ? "table"
        : block.kind === "list"
          ? "list"
          : inferBoundaryType(content);
  const makePiece = (piece: string): SemanticParentPiece => ({
    content: piece,
    boundaryType,
    pageStart: pageStartFromNumbers(pages),
    pageEnd: pageEndFromNumbers(pages),
  });

  if (content.length <= PARENT_TARGET_CHARS) return [makePiece(content)];
  if (block.kind === "table") {
    const lines = content.split("\n").map((text) => ({ text, page: null }));
    const tableBlock: TextBlock = { content, boundaryType: "table", lines };
    return splitTableBlock(tableBlock).flatMap((piece) => {
      const markdown = piece.map((line) => line.text).join("\n");
      return markdown.length <= PARENT_MAX_CHARS
        ? [makePiece(markdown)]
        : recursiveSplitText(markdown, PARENT_TARGET_CHARS).map(makePiece);
    });
  }
  if (block.kind === "code") {
    return splitFencedCode(content, PARENT_TARGET_CHARS).map(makePiece);
  }
  return recursiveSplitText(content, PARENT_TARGET_CHARS).map(makePiece);
}

// 将节点 provenance 页码转换为父块起始页。
function pageStartFromNumbers(pages: number[]): number | null {
  return pages.length === 0 ? null : Math.min(...pages);
}

// 将节点 provenance 页码转换为父块结束页。
function pageEndFromNumbers(pages: number[]): number | null {
  return pages.length === 0 ? null : Math.max(...pages);
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

// 按递归语义边界生成子片段。
export function splitChildChunks(content: string): ChildChunkInput[] {
  return splitChildContent(content).map((chunk, index) => ({
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
        ? block.boundaryType === "table"
          ? splitTableBlock(block)
          : splitBlockBySentenceThenLength(block, PARENT_TARGET_CHARS, PARENT_MAX_CHARS)
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

// 提取 Markdown 表格的表头行（首行 + 分隔行；无分隔行时仅首行）。
function extractTableHeader(lines: PageAwareLine[]): PageAwareLine[] {
  const first = lines[0];
  if (first === undefined || !isMarkdownTableLine(first.text)) {
    return [];
  }
  const second = lines[1];
  if (second !== undefined && isMarkdownTableSeparatorLine(second.text)) {
    return [first, second];
  }
  return [first];
}

// 按行拆分超长表格块并为每个片段补表头，保证数据行不被截断。
function splitTableBlock(block: TextBlock): PageAwareLine[][] {
  const header = extractTableHeader(block.lines);
  const headerChars = header.reduce((sum, line) => sum + line.text.length + 1, 0);
  const pieces: PageAwareLine[][] = [];
  let current: PageAwareLine[] = [];
  let currentChars = headerChars;

  function flush(): void {
    if (current.length > 0) {
      pieces.push([...header, ...current]);
    }
    current = [];
    currentChars = headerChars;
  }

  for (const line of block.lines.slice(header.length)) {
    const lineChars = line.text.length + 1;
    if (current.length > 0 && currentChars + lineChars > PARENT_TARGET_CHARS) {
      flush();
    }
    current.push(line);
    currentChars += lineChars;
  }
  flush();

  return pieces;
}

// 纯表格内容按行切分并补表头（表头即上下文，不做重叠），其余内容沿用长度切分。
function splitChildContent(content: string): string[] {
  const normalized = content.trim();
  if (normalized.length <= CHILD_TARGET_CHARS) {
    return normalized.length === 0 ? [] : [normalized];
  }
  const lines: PageAwareLine[] = normalized.split("\n").map((text) => ({ text, page: null }));
  const isPureTable = lines.every(
    (line) => line.text.trim().length === 0 || isMarkdownTableLine(line.text),
  );
  const header = isPureTable ? extractTableHeader(lines) : [];
  if (header.length > 0) {
    return splitChildTable(lines, header);
  }

  const markdownBlocks = splitMarkdownBlocks(normalized);
  const chunks: string[] = [];
  let current: string[] = [];

  function flush(): void {
    if (current.length > 0) {
      chunks.push(current.join("\n\n").trim());
    }
    current = [];
  }

  for (const block of markdownBlocks) {
    const pieces = splitChildBlock(block);
    for (const piece of pieces) {
      const currentText = current.join("\n\n");
      if (current.length > 0 && currentText.length + piece.length + 2 > CHILD_TARGET_CHARS) {
        flush();
      }
      current.push(piece);
    }
  }
  flush();
  return chunks;
}

// 按 Markdown 块类型选择递归分隔符，避免直接从任意字符位置截断句子或代码。
function splitChildBlock(block: string): string[] {
  const normalized = block.trim();
  if (normalized.length <= CHILD_TARGET_CHARS) return [normalized];
  if (isMarkdownTableBlock(normalized)) {
    const tableLines = normalized.split("\n").map((text) => ({ text, page: null }));
    return splitChildTable(tableLines, extractTableHeader(tableLines));
  }
  if (isFencedCodeBlock(normalized)) {
    return splitFencedCode(normalized, CHILD_TARGET_CHARS);
  }
  const pieces = recursiveSplitText(normalized, CHILD_TARGET_CHARS);
  return isListLine(normalized.split("\n")[0] ?? "") ? pieces : addCompleteSentenceOverlap(pieces);
}

// 在相邻普通文本子块间复用完整句子，保留上下文且不从句中截取重叠区。
function addCompleteSentenceOverlap(chunks: string[]): string[] {
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = chunks[index - 1]?.trimEnd() ?? "";
    const matches = [...previous.matchAll(/[^。！？.!?]+[。！？.!?]+[”’"')\]]*/gu)];
    let overlap = "";
    for (let sentenceIndex = matches.length - 1; sentenceIndex >= 0; sentenceIndex -= 1) {
      const sentence = matches[sentenceIndex]?.[0] ?? "";
      if (sentence.length === 0 || overlap.length + sentence.length > CHILD_OVERLAP_CHARS) break;
      overlap = `${sentence}${overlap}`;
    }
    if (overlap.length === 0 || overlap.length + chunk.length > CHILD_TARGET_CHARS) return chunk;
    const separator = /[A-Za-z0-9]$/.test(overlap) && /^[A-Za-z0-9]/.test(chunk) ? " " : "";
    return `${overlap}${separator}${chunk}`;
  });
}

// 按空行拆 Markdown 块，同时保持围栏代码和表格内部的原始换行。
function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: string | null = null;

  function flush(): void {
    const block = lines.join("\n").trim();
    if (block.length > 0) blocks.push(block);
    lines = [];
  }

  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence === null && fenceMatch !== null) {
      fence = fenceMatch[1] ?? null;
    } else if (fence !== null && fenceMatch !== null && line.trimStart().startsWith(fence)) {
      fence = null;
    }
    if (line.trim().length === 0 && fence === null) {
      flush();
    } else {
      lines.push(line);
    }
  }
  flush();
  return blocks;
}

// 判断块是否由 Markdown 表格行组成。
function isMarkdownTableBlock(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every(isMarkdownTableLine);
}

// 将超长表格按整行拆分，并在每个子块重复表头。
function splitChildTable(lines: PageAwareLine[], header: PageAwareLine[]): string[] {
  if (header.length === 0) {
    return recursiveSplitText(lines.map((line) => line.text).join("\n"), CHILD_TARGET_CHARS);
  }
  const headerTexts = header.map((line) => line.text);
  const headerChars = headerTexts.reduce((sum, text) => sum + text.length + 1, 0);
  if (headerChars >= CHILD_TARGET_CHARS) {
    return recursiveSplitText(lines.map((line) => line.text).join("\n"), CHILD_TARGET_CHARS);
  }
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = headerChars;

  function flush(): void {
    if (current.length > 0) chunks.push([...headerTexts, ...current].join("\n").trim());
    current = [];
    currentChars = headerChars;
  }

  for (const line of lines.slice(header.length)) {
    const lineChars = line.text.length + 1;
    if (current.length > 0 && currentChars + lineChars > CHILD_TARGET_CHARS) {
      flush();
    }
    if (headerChars + lineChars > CHILD_TARGET_CHARS) {
      const maxRowChars = Math.max(1, CHILD_TARGET_CHARS - headerChars - 1);
      for (const part of recursiveSplitText(line.text, maxRowChars)) {
        chunks.push([...headerTexts, part].join("\n").trim());
      }
      continue;
    }
    current.push(line.text);
    currentChars += lineChars;
  }
  flush();
  return chunks;
}

// 逐级使用段落、换行、句末标点、短语和字符边界切分超长文本。
function recursiveSplitText(text: string, targetChars: number, separatorIndex = 0): string[] {
  const normalized = text.trim();
  if (normalized.length <= targetChars) return normalized.length === 0 ? [] : [normalized];
  const separators = ["\n\n", "\n", "。", "！", "？", "!", "?", "；", ";", "，", ",", ". ", " "];
  const separator = separators[separatorIndex];
  if (separator === undefined) return hardSplitByCodePoint(normalized, targetChars);

  const pieces = splitKeepingSeparator(normalized, separator);
  if (pieces.length < 2) return recursiveSplitText(normalized, targetChars, separatorIndex + 1);
  const output: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const smaller =
      piece.length > targetChars
        ? recursiveSplitText(piece, targetChars, separatorIndex + 1)
        : [piece];
    for (const part of smaller) {
      if (part.length === 0) continue;
      if (current.length > 0 && current.length + part.length > targetChars) {
        output.push(current.trim());
        current = "";
      }
      current += part;
    }
  }
  if (current.trim().length > 0) output.push(current.trim());
  return output.length > 0
    ? output
    : recursiveSplitText(normalized, targetChars, separatorIndex + 1);
}

// 按保留分隔符的方式拆文本，句末标点留在前一句末尾。
function splitKeepingSeparator(text: string, separator: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (;;) {
    const index = text.indexOf(separator, start);
    if (index < 0) break;
    const end = index + separator.length;
    if (end > start) pieces.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

// 最后兜底按 Unicode 码点拆分，避免把代理对拆成无效字符。
function hardSplitByCodePoint(text: string, targetChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length > 0 && current.length + character.length > targetChars) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// 识别完整的围栏代码块。
function isFencedCodeBlock(text: string): boolean {
  const lines = text.split("\n");
  return (
    lines.length >= 2 &&
    /^\s*(```+|~~~+)/.test(lines[0] ?? "") &&
    /^(\s*`{3,}|\s*~{3,})$/.test(lines[lines.length - 1] ?? "")
  );
}

// 超长代码只在代码行边界拆分，并为每个子片段补齐代码围栏。
function splitFencedCode(text: string, targetChars: number): string[] {
  const lines = text.split("\n");
  const opening = lines[0] ?? "```";
  const fence = /^\s*(?:(`{3,})|(~{3,}))(.*)$/.exec(opening);
  if (fence === null || lines.length < 2) return recursiveSplitText(text, targetChars);
  const marker = fence[1] ?? fence[2] ?? "```";
  const closing = marker;
  const bodyEnd = isFencedCodeBlock(text) ? lines.length - 1 : lines.length;
  const body = lines.slice(1, bodyEnd);
  const chunks: string[] = [];
  let current: string[] = [];
  let size = opening.length + closing.length + 2;

  function flush(): void {
    if (current.length > 0) chunks.push([opening, ...current, closing].join("\n"));
    current = [];
    size = opening.length + closing.length + 2;
  }

  for (const line of body) {
    if (current.length > 0 && size + line.length + 1 > targetChars) flush();
    if (line.length + opening.length + closing.length + 2 > targetChars) {
      for (const part of hardSplitByCodePoint(
        line,
        Math.max(1, targetChars - opening.length - closing.length - 2),
      )) {
        if (current.length > 0) flush();
        chunks.push([opening, part, closing].join("\n"));
      }
    } else {
      current.push(line);
      size += line.length + 1;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
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
  let currentPage: number | null = hasPageMarkers(text) ? 1 : null;
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
      const single = normalized.lastIndexOf("\n", hardEnd);
      const sentence = normalized.lastIndexOf("\u3002", hardEnd);
      const space = normalized.lastIndexOf(" ", hardEnd);
      const candidate = Math.max(newline, single, sentence, space);
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
