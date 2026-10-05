// 清洗与切分共用的标题、列表、表格及页码识别。

export const PAGE_BREAK_MARKER_PREFIX = "[[KNOWFLOW_PAGE_BREAK:";

// 识别 Markdown、中英文编号与章节标题。
export function detectHeadingLine(line: string): { title: string; level: number } | null {
  const trimmed = line.trim();
  const markdown = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (markdown !== null) {
    return { level: markdown[1]?.length ?? 1, title: markdown[2]?.trim() ?? "" };
  }

  const numbered = /^(\d+(?:\.\d+){0,3})[.、]?\s+(.{2,80})$/.exec(trimmed);
  if (numbered !== null && !/[。！？.!?]$/.test(trimmed)) {
    const level = Math.min(numbered[1]?.split(".").length ?? 1, 6);
    return { level, title: trimmed };
  }

  const chineseChapter = /^(第[一二三四五六七八九十百千万\d]+[章节篇部])\s*(.{0,80})$/.exec(
    trimmed,
  );
  if (chineseChapter !== null) {
    return { level: 1, title: trimmed };
  }

  const chineseNumbered =
    /^([一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十]+）)\s*(.{2,80})$/.exec(trimmed);
  if (chineseNumbered !== null && !/[。！？.!?]$/.test(trimmed)) {
    return { level: trimmed.startsWith("（") ? 3 : 2, title: trimmed };
  }

  return null;
}

// 判断当前行是否属于 Markdown 表格。
export function isMarkdownTableLine(line: string): boolean {
  return /^\|.*\|$/.test(line.trim());
}

// 识别有序与无序列表行。
export function isListLine(line: string): boolean {
  return /^(\s*[-*+]\s+|\s*\d+[.)、]\s+|\s*[（(]?[一二三四五六七八九十]+[）).、]\s+)/.test(line);
}

// 读取内部页码标记中的正整数页码。
export function pageMarkerNumber(line: string): number | null {
  const match = new RegExp(`^${escapeRegExp(PAGE_BREAK_MARKER_PREFIX)}(\\d+)\\]\\]$`).exec(
    line.trim(),
  );
  if (match === null) {
    return null;
  }
  const page = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(page) && page > 0 ? page : null;
}

// 转义正则表达式中的特殊字符。
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 移除正文中的内部页码标记。
export function stripPageMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => pageMarkerNumber(line) === null)
    .join("\n");
}
