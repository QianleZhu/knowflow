// CSV/Excel 直接输出结构化表格，工作表行号属于来源信息，不充当 PDF 页码。
import type { ParsedDocument } from "./types.js";
import type { ContentSource, ParsedContentBlock, TableRow } from "../document-blocks.js";
import { toParsedDocument } from "./cleaner.js";
import { readSpreadsheet } from "./spreadsheet-reader.js";
import { renderTable } from "./structured-content.js";

const MAX_SPREADSHEET_ROWS = 10000;

// 原生读取工作表，在空行处分区，保留每条记录的原始工作表行号。
export async function parseCsvExcelDocument(
  buffer: Buffer,
  kind: "csv" | "excel",
): Promise<ParsedDocument> {
  const spreadsheet = await readSpreadsheet(buffer, kind);
  if (spreadsheet.rowCount > MAX_SPREADSHEET_ROWS) throw new Error("表格文档不能超过 10000 行");
  const blocks: ParsedContentBlock[] = [];
  for (const [sheetIndex, sheet] of spreadsheet.sheets.entries()) {
    const sheetId = `sheet:${String(sheetIndex)}`;
    blocks.push({
      kind: "heading",
      markdown: `## 工作表：${sheet.name}`,
      level: 2,
      pageNumbers: [],
      sources: [{ blockId: sheetId, pageNumbers: [], precision: "block", sheet: sheet.name }],
    });
    let region: TableRow[] = [];
    let previousRow = 0;
    // 保存相邻非空行区域；无法确认首行是表头时保留为数据并使用列名占位符。
    function flushRegion(): void {
      if (region.length === 0) return;
      const columnCount = Math.max(...region.map((row) => row.cells.length));
      region = region.map((row) => ({
        ...row,
        cells: Array.from(
          { length: columnCount },
          (_, index) => row.cells[index] ?? { text: "", sources: row.sources },
        ),
      }));
      const first = region[0];
      if (first === undefined) throw new Error("表格区域缺少数据行");
      const firstTexts = first.cells.map((cell) => cell.text);
      const hasHeader =
        region.length > 1 &&
        firstTexts.every((text) => text.length > 0 && !/^[-+]?\d+(?:\.\d+)?$/.test(text)) &&
        new Set(firstTexts).size === firstTexts.length;
      const header: TableRow = hasHeader
        ? first
        : {
            id: `${first.id}:header`,
            sources: [],
            cells: first.cells.map((_, index) => ({
              text: `列 ${String(index + 1)}`,
              sources: [],
            })),
          };
      const rows = hasHeader ? region.slice(1) : region;
      const table = { header, rows };
      blocks.push({
        kind: "table",
        markdown: renderTable(table),
        level: null,
        pageNumbers: [],
        table,
        sources: region.flatMap((row) => row.sources),
      });
      region = [];
    }
    sheet.rows.forEach((cells, index) => {
      const rowNumber = sheet.rowNumbers[index];
      if (rowNumber === undefined) throw new Error("工作表缺少原始行号");
      if (region.length > 0 && rowNumber > previousRow + 1) flushRegion();
      const id = `${sheetId}:row:${String(rowNumber)}`;
      const source: ContentSource = {
        blockId: id,
        pageNumbers: [],
        precision: "row",
        sheet: sheet.name,
        rowStart: rowNumber,
        rowEnd: rowNumber,
      };
      region.push({
        id,
        sources: [source],
        cells: cells.map((text) => ({ text, sources: [source] })),
      });
      previousRow = rowNumber;
    });
    flushRegion();
  }
  const parsed = await toParsedDocument(
    blocks.map((block) => block.markdown).join("\n\n"),
    spreadsheet.parser,
    { sheetCount: spreadsheet.sheets.length, rowCount: spreadsheet.rowCount },
  );
  return { ...parsed, structuredBlocks: blocks };
}
