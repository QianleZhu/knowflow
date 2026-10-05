// CSV、现代 Excel 与旧版 Excel 的共享工作表读取和单元格规范化。
import * as XLS from "@e965/xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";
import type { CellValue } from "read-excel-file/node";

type SpreadsheetCellValue = CellValue | null;

export type SpreadsheetKind = "csv" | "excel";
export type SpreadsheetParser = "csv-parse" | "read-excel-file" | "@e965/xlsx";

export type SpreadsheetSheet = {
  name: string;
  rows: string[][];
};

export type SpreadsheetReadResult = {
  sheets: SpreadsheetSheet[];
  rowCount: number;
  parser: SpreadsheetParser;
};

// 按 CSV 或 Excel 格式读取工作表，并保留行数与实际解析器信息。
export async function readSpreadsheet(
  buffer: Buffer,
  kind: SpreadsheetKind,
): Promise<SpreadsheetReadResult> {
  if (kind === "csv") {
    const rows = parseCsvRows(buffer);
    return {
      sheets: rows.length === 0 ? [] : [{ name: "Sheet1", rows }],
      rowCount: rows.length,
      parser: "csv-parse",
    };
  }

  if (hasOleCompoundSignature(buffer)) {
    return readLegacyExcelFile(buffer);
  }

  const parsedSheets = await readXlsxFile(buffer);
  const sheets = parsedSheets
    .map((sheet) => ({ name: sheet.sheet, rows: worksheetRows(sheet.data) }))
    .filter((sheet) => sheet.rows.length > 0);
  const rowCount = sheets.reduce((total, sheet) => total + sheet.rows.length, 0);

  return { sheets, rowCount, parser: "read-excel-file" };
}

// 解析带 BOM、空行和不等长列的 CSV 内容。
function parseCsvRows(buffer: Buffer): string[][] {
  const records = parseCsv(buffer, {
    bom: true,
    relaxColumnCount: true,
    skipEmptyLines: true,
  }) as unknown;

  if (!Array.isArray(records)) {
    throw new Error("CSV 解析结果无效");
  }

  return records
    .filter((record): record is unknown[] => Array.isArray(record))
    .map((record) => record.map((cell) => normalizeCell(cell)));
}

// 规范化工作表单元格并移除空行及尾部空列。
function worksheetRows(rows: SpreadsheetCellValue[][]): string[][] {
  return rows
    .map((row) => {
      const normalized = row.map((value) => normalizeCell(value));
      return trimTrailingEmptyCells(normalized);
    })
    .filter((row) => row.some((cell) => cell.length > 0));
}

// 使用旧版 Excel 读取器解析 OLE 工作簿，并关闭无关格式信息读取。
function readLegacyExcelFile(buffer: Buffer): SpreadsheetReadResult {
  const workbook = XLS.read(buffer, {
    type: "buffer",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
  });
  const sheets = workbook.SheetNames.map((name) => {
    const worksheet = workbook.Sheets[name];
    const rows =
      worksheet === undefined
        ? []
        : worksheetRows(
            XLS.utils.sheet_to_json<SpreadsheetCellValue[]>(worksheet, {
              header: 1,
              blankrows: false,
              defval: "",
              raw: false,
            }),
          );
    return { name, rows };
  }).filter((sheet) => sheet.rows.length > 0);
  const rowCount = sheets.reduce((total, sheet) => total + sheet.rows.length, 0);

  return { sheets, rowCount, parser: "@e965/xlsx" };
}

// 判断是否需要使用旧版 Excel 的 OLE 解析路径。
function hasOleCompoundSignature(buffer: Buffer): boolean {
  return buffer
    .subarray(0, 8)
    .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

// 将常见单元格类型转换为统一文本表示。
function normalizeCell(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return "";
  }
  if (
    typeof cell === "string" ||
    typeof cell === "number" ||
    typeof cell === "boolean" ||
    typeof cell === "bigint"
  ) {
    return normalizeText(String(cell));
  }
  if (cell instanceof Date) {
    return cell.toISOString();
  }
  if (typeof cell === "object") {
    return normalizeObjectCell(cell as Record<string, unknown>);
  }
  return "";
}

// 提取文本、公式结果和富文本单元格的可读内容。
function normalizeObjectCell(cell: Record<string, unknown>): string {
  const text = cell["text"];
  if (typeof text === "string") {
    return normalizeText(text);
  }

  const result = cell["result"];
  if (
    typeof result === "string" ||
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "bigint"
  ) {
    return normalizeText(String(result));
  }

  const richText = cell["richText"];
  if (Array.isArray(richText)) {
    return normalizeText(
      richText
        .map((part) =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as Record<string, unknown>)["text"] === "string"
            ? ((part as Record<string, unknown>)["text"] as string)
            : "",
        )
        .join(""),
    );
  }

  return "";
}

// 统一单元格换行符并去除首尾空白。
function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// 去除工作表行末连续空单元格。
function trimTrailingEmptyCells(row: string[]): string[] {
  let lastIndex = row.length - 1;
  while (lastIndex >= 0 && row[lastIndex]?.length === 0) {
    lastIndex -= 1;
  }
  return row.slice(0, lastIndex + 1);
}
