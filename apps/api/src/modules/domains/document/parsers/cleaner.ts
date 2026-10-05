// 正文清洗与统一解析结果封装。
import type { ParsedDocument, ParsedDocumentExtraMetadata } from "./types.js";
import {
  PAGE_BREAK_MARKER_PREFIX,
  detectHeadingLine,
  isMarkdownTableLine,
  isListLine,
  pageMarkerNumber,
} from "../document-text-structure.js";

const CLEANER_VERSION = "document-cleaner-v1";

// 清理控制字符、重复页眉页脚和硬换行。
export function cleanParsedText(text: string): {
  text: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  let cleaned = removeControlCharacters(text.replace(/\r\n?/g, "\n"));
  const beforeControlLength = text.length;
  if (cleaned.length !== beforeControlLength) {
    warnings.push("control_chars_removed");
  }

  cleaned = removeRepeatedPageChrome(cleaned, warnings);
  cleaned = mergeHardWrappedLines(cleaned);
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length === 0) {
    throw new Error("文档没有可提取的文本内容");
  }
  return { text: cleaned, warnings };
}

// 统一 PDF 页码标记并记录页码不可用状态。
function prepareRawTextForCleaning(
  text: string,
  parser: ParsedDocument["metadata"]["parser"],
): {
  text: string;
  pageInfoUnavailable: boolean;
} {
  if (parser !== "pdf-parse") {
    return { text, pageInfoUnavailable: false };
  }
  if (text.includes(PAGE_BREAK_MARKER_PREFIX)) {
    return { text, pageInfoUnavailable: false };
  }
  if (!text.includes("\f")) {
    return { text, pageInfoUnavailable: true };
  }

  const pages = text.split("\f");
  const marked = pages
    .map((page, index) =>
      index === 0 ? page : `${PAGE_BREAK_MARKER_PREFIX}${String(index + 1)}]]\n${page}`,
    )
    .join("\n");
  return { text: marked, pageInfoUnavailable: false };
}

// 按跨页出现频率移除页眉页脚。
function removeRepeatedPageChrome(text: string, warnings: string[]): string {
  const pages = splitTextByPageMarker(text);
  const pageCount = pages.length;
  const repeated = new Map<string, number>();
  for (const page of pages) {
    const candidates = page.lines
      .map((line) => line.trim())
      .filter((line) => isPageChromeCandidate(line));
    for (const candidate of new Set(candidates)) {
      repeated.set(candidate, (repeated.get(candidate) ?? 0) + 1);
    }
  }
  const repeatedChrome = new Set(
    [...repeated.entries()]
      .filter(([, count]) => count >= Math.max(2, Math.ceil(pageCount * 0.6)))
      .map(([line]) => line),
  );
  if (repeatedChrome.size > 0) {
    warnings.push("repeated_page_chrome_removed");
  }

  return pages
    .map((page, index) => {
      const lines = page.lines.filter((line) => {
        const trimmed = line.trim();
        return !isStandalonePageNumber(trimmed) && !repeatedChrome.has(trimmed);
      });
      const prefix = index === 0 ? "" : `${PAGE_BREAK_MARKER_PREFIX}${String(page.page)}]]\n`;
      return `${prefix}${lines.join("\n")}`;
    })
    .join("\n");
}

// 保留制表与换行并移除不可见控制字符。
function removeControlCharacters(text: string): string {
  let cleaned = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || (code > 31 && code !== 127)) {
      cleaned += char;
    }
  }
  return cleaned;
}

// 按内部页码标记拆分文本页。
function splitTextByPageMarker(text: string): { page: number; lines: string[] }[] {
  const pages: { page: number; lines: string[] }[] = [{ page: 1, lines: [] }];
  let current = pages[0] as { page: number; lines: string[] };
  for (const line of text.split("\n")) {
    const marker = pageMarkerNumber(line);
    if (marker !== null) {
      current = { page: marker, lines: [] };
      pages.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return pages;
}

// 合并解析产生的段落硬换行。
function mergeHardWrappedLines(text: string): string {
  const output: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const current = line.trimEnd();
    const previous = output[output.length - 1];
    if (previous !== undefined && shouldMergeHardWrappedLine(previous, current)) {
      const separator = needsSpaceBetween(previous, current) ? " " : "";
      output[output.length - 1] = `${previous}${separator}${current.trimStart()}`;
    } else {
      output.push(current);
    }
  }
  return output.join("\n");
}

// 判断相邻行是否属于同一段落。
function shouldMergeHardWrappedLine(previous: string, current: string): boolean {
  if (previous.trim().length === 0 || current.trim().length === 0) {
    return false;
  }
  if (isProtectedLine(previous) || isProtectedLine(current)) {
    return false;
  }
  if (/[。！？.!?:：；;]$/.test(previous.trim())) {
    return false;
  }
  if (detectHeadingLine(previous) !== null || detectHeadingLine(current) !== null) {
    return false;
  }
  return previous.trim().length >= 8 && current.trim().length >= 6;
}

// 判断英文或数字相邻行是否需要空格。
function needsSpaceBetween(previous: string, current: string): boolean {
  return /[A-Za-z0-9]$/.test(previous.trim()) && /^[A-Za-z0-9]/.test(current.trim());
}

// 保护页码、标题、列表和表格边界。
function isProtectedLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    pageMarkerNumber(trimmed) !== null ||
    isMarkdownTableLine(trimmed) ||
    isListLine(trimmed) ||
    isStandalonePageNumber(trimmed)
  );
}

// 识别可能属于页眉页脚的短行。
function isPageChromeCandidate(line: string): boolean {
  if (line.length === 0 || line.length > 80) {
    return false;
  }
  return (
    isStandalonePageNumber(line) ||
    /^第\s*\d+\s*页(?:\s*\/\s*共\s*\d+\s*页)?$/.test(line) ||
    /^Page\s+\d+(?:\s+of\s+\d+)?$/i.test(line) ||
    /^[\w\s.-]{4,80}$/.test(line)
  );
}

// 识别独立页码行。
function isStandalonePageNumber(line: string): boolean {
  return /^\d{1,4}$/.test(line) || /^[-–—]\s*\d{1,4}\s*[-–—]$/.test(line);
}

// 统一清洗正文并生成解析时间、长度与告警元数据。
export function toParsedDocument(
  text: string,
  parser: ParsedDocument["metadata"]["parser"],
  extraMetadata: ParsedDocumentExtraMetadata = {},
): ParsedDocument {
  const rawTextLength = text.length;
  const prepared = prepareRawTextForCleaning(text, parser);
  const cleaned = cleanParsedText(prepared.text);

  return {
    text: cleaned.text,
    metadata: {
      parser,
      parsedAt: new Date().toISOString(),
      textLength: cleaned.text.length,
      rawTextLength,
      cleanedTextLength: cleaned.text.length,
      cleanerVersion: CLEANER_VERSION,
      cleaningWarnings: cleaned.warnings,
      ...(prepared.pageInfoUnavailable ? { pageInfoUnavailable: true as const } : {}),
      ...extraMetadata,
    },
  };
}
