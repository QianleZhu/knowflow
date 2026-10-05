// CSV 与 Excel 正文解析。
import type { ParsedDocument } from "./types.js";
import { toParsedDocument } from "./cleaner.js";
import { readSpreadsheet } from "./spreadsheet-reader.js";

const MAX_SPREADSHEET_ROWS = 10000;

// 将 CSV 与 Excel 工作表转为 Markdown 表格。
export async function parseCsvExcelDocument(
  buffer: Buffer,
  kind: "csv" | "excel",
): Promise<ParsedDocument> {
  const spreadsheet = await readSpreadsheet(buffer, kind);
  const sheetTexts: string[] = [];
  if (spreadsheet.rowCount > MAX_SPREADSHEET_ROWS) {
    throw new Error("表格文档不能超过 10000 行");
  }

  for (const sheet of spreadsheet.sheets) {
    sheetTexts.push(`## 工作表：${sheet.name}\n\n${rowsToMarkdownTable(sheet.rows)}`);
  }

  return toParsedDocument(sheetTexts.join("\n\n"), spreadsheet.parser, {
    sheetCount: spreadsheet.sheets.length,
    rowCount: spreadsheet.rowCount,
  });
}

// 将工作表行补齐列数后生成 Markdown 表格。
function rowsToMarkdownTable(rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const cells = Array.from({ length: columnCount }, (_value, columnIndex) =>
      markdownTableCell(row[columnIndex] ?? ""),
    );
    lines.push(`| ${cells.join(" | ")} |`);
    if (index === 0) {
      lines.push(`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`);
    }
  });
  return lines.join("\n");
}

// 转义表格单元格中的换行与竖线。
function markdownTableCell(value: string): string {
  return value.replace(/\n/g, " ").replace(/\|/g, "\\|");
}
