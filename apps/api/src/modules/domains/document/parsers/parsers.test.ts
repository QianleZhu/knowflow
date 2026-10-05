// 解析拆分回归：真实格式解析、注册表校验和 WebP 装饰图预算。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import * as XLS from "@e965/xlsx";
import {
  detectDocumentUploadKind,
  detectBatchImportKind,
  validateDocumentUploadContent,
  validateBatchImportContent,
} from "../../../../shared/upload/upload-file-validation.js";
import { parseSpreadsheetForBatchImport } from "../../../../shared/import/spreadsheet-import.js";
import { splitChildChunks } from "../document-chunker.js";
import { readImageDimensions } from "./image-dimensions.js";
import { parseDocumentBuffer } from "./registry.js";
import type { ParserContext } from "./types.js";
import { describeImageWithVision, newVisionBudget, newVisionStats } from "./vision-ocr.js";

const context: ParserContext = {
  sourceType: "txt",
  mimeType: "text/plain",
  documentId: "parser-regression",
  title: "解析回归",
};

// 构造三种 WebP 编码的尺寸头，独立验证 image-size 的格式识别。
function webpHeader(format: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8);
  buffer.write(format, 12);
  buffer.writeUInt32LE(10, 16);
  if (format === "VP8X") {
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
  } else if (format === "VP8L") {
    buffer[20] = 0x2f;
    buffer.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    buffer.set([0x9d, 0x01, 0x2a], 23);
    buffer.writeUInt16LE(width, 26);
    buffer.writeUInt16LE(height, 28);
  }
  return buffer;
}

void describe("image-size and WebP regression", () => {
  for (const format of ["VP8X", "VP8L", "VP8 "] as const) {
    void it(`reads ${format} dimensions from bytes`, () => {
      assert.deepEqual(readImageDimensions(webpHeader(format, 320, 240)), {
        width: 320,
        height: 240,
      });
    });
  }

  void it("skips small WebP before calling OCR or consuming budget", async () => {
    const buffer = webpHeader("VP8X", 32, 32);
    const budget = newVisionBudget();
    const stats = newVisionStats();
    const text = await describeImageWithVision(
      {
        buffer,
        mimeType: "image/webp",
        sourceLabel: "DOCX 装饰图",
        ...readImageDimensions(buffer),
        skipDecorative: true,
      },
      budget,
      stats,
    );
    assert.equal(text, null);
    assert.equal(stats.skippedDecorative, 1);
    assert.equal(stats.attempted, 0);
    assert.equal(budget.used, 0);
  });

  void it("keeps unknown dimensions safe for damaged and empty inputs", () => {
    for (const buffer of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from("RIFF")]) {
      assert.deepEqual(readImageDimensions(buffer), { width: null, height: null });
    }
  });

  void it("matches extension, MIME and image-size type rather than trusting a renamed file", () => {
    const buffer = webpHeader("VP8X", 320, 240);
    const file = { originalname: "diagram.WEBP", mimetype: "image/webp", buffer };
    const kind = detectDocumentUploadKind(file);
    assert.deepEqual(kind, { sourceType: "image", extension: ".webp" });
    assert.ok(validateDocumentUploadContent(file, kind));
    assert.equal(
      validateDocumentUploadContent(file, { sourceType: "image", extension: ".png" }),
      false,
    );
    assert.equal(detectDocumentUploadKind({ ...file, mimetype: "image/png" }), null);
    assert.equal(validateDocumentUploadContent({ ...file, buffer: Buffer.alloc(0) }, kind), false);
  });
});

void describe("parser registry and shared spreadsheet regression", () => {
  void it("parses a real PDF with page markers and unchanged parser metadata", async () => {
    const buffer = await readFile(new URL("./fixtures/text.pdf", import.meta.url));
    const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "pdf" });
    assert.match(parsed.text, /Parser regression document/);
    assert.match(parsed.text, /\[\[KNOWFLOW_PAGE_BREAK:1\]\]/);
    assert.equal(parsed.metadata.parser, "pdf-parse");
    assert.equal(parsed.metadata.pdfPageCount, 1);
    assert.equal(parsed.metadata.scannedPdfDetected, undefined);
    assert.equal(parsed.metadata.visionImageCount, 0);
  });

  void it("filters an embedded WebP decoration in a real DOCX without calling OCR", async () => {
    const buffer = await readFile(new URL("./fixtures/decorative-webp.docx", import.meta.url));
    const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "docx" });
    assert.match(parsed.text, /装饰图之前的正文/);
    assert.match(parsed.text, /装饰图之后的正文/);
    assert.equal(parsed.text.includes("KNOWFLOW_DOCX_IMAGE"), false);
    assert.equal(parsed.metadata.parser, "mammoth");
    assert.equal(parsed.metadata.visionImageSkippedCount, 1);
    assert.equal(parsed.metadata.visionImageCount, 0);
    assert.equal(parsed.metadata.visionImageFailedCount, 0);
  });

  void it("dispatches UTF-8 text and Markdown through the same cleaner", async () => {
    for (const sourceType of ["txt", "markdown"] as const) {
      const parsed = await parseDocumentBuffer(Buffer.from("# 标题\n\n正文内容\u0000"), {
        ...context,
        sourceType,
      });
      assert.equal(parsed.text, "# 标题\n\n正文内容");
      assert.equal(parsed.metadata.parser, "plain-text");
      assert.deepEqual(parsed.metadata.cleaningWarnings, ["control_chars_removed"]);
    }
  });

  void it("rejects empty text and unsupported sources", async () => {
    await assert.rejects(parseDocumentBuffer(Buffer.alloc(0), context), /没有可提取的文本/);
    await assert.rejects(
      parseDocumentBuffer(Buffer.from("正文"), { ...context, sourceType: "web_url" }),
      /不支持的文档来源类型/,
    );
  });

  void it("keeps CSV tables and batch-import reader connected after migration", async () => {
    const buffer = Buffer.from('title,content\n流程,"第一步|第二步"');
    const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "csv" });
    assert.equal(parsed.metadata.parser, "csv-parse");
    assert.match(parsed.text, /第一步\\\|第二步/);
    assert.equal(parsed.metadata.rowCount, 2);
    const imported = await parseSpreadsheetForBatchImport(buffer, "csv");
    assert.equal(imported.rows[0]?.content, "第一步|第二步");
  });

  for (const bookType of ["xlsx", "xls"] as const) {
    void it(`parses real ${bookType} workbook and reuses upload validation`, async () => {
      const workbook = XLS.utils.book_new();
      XLS.utils.book_append_sheet(
        workbook,
        XLS.utils.aoa_to_sheet([
          ["title", "content"],
          ["流程", "步骤"],
        ]),
        "业务",
      );
      const buffer = XLS.write(workbook, { type: "buffer", bookType }) as Buffer;
      const mimeType =
        bookType === "xls"
          ? "application/vnd.ms-excel"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const file = { originalname: `data.${bookType}`, mimetype: mimeType, buffer };
      assert.equal(detectBatchImportKind(file), "excel");
      assert.ok(validateBatchImportContent(file, "excel"));
      // 内容校验与格式检测保持分工，不改变旧的批量导入接口语义。
      assert.ok(
        validateBatchImportContent({ ...file, mimetype: "application/octet-stream" }, "excel"),
      );
      assert.equal(validateBatchImportContent(file, "csv"), false);
      const parsed = await parseDocumentBuffer(buffer, {
        ...context,
        sourceType: "excel",
        mimeType,
      });
      assert.equal(parsed.metadata.parser, bookType === "xls" ? "@e965/xlsx" : "read-excel-file");
      assert.equal(parsed.metadata.sheetCount, 1);
      assert.equal(parsed.metadata.rowCount, 2);
      assert.match(parsed.text, /业务/);
      const imported = await parseSpreadsheetForBatchImport(buffer, "excel");
      assert.equal(imported.rows[0]?.title, "流程");
    });
  }

  void it("keeps child overlap at 120 characters after extraction", () => {
    const text = "知识流程".repeat(600);
    const children = splitChildChunks(text);
    assert.ok(children.length > 1);
    assert.equal(children[0]?.content.slice(-120), children[1]?.content.slice(0, 120));
    assert.ok(children.every((child) => child.content.length <= 900 && child.tokenCount > 0));
  });
});
