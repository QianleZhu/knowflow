// 解析拆分回归：真实格式解析、注册表校验和 WebP 装饰图预算。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import * as XLS from "@e965/xlsx";
import { toParsedDocument } from "./cleaner.js";
import { buildTextPdf } from "./fixtures/pdf-fixtures.js";
import { PDFParse } from "pdf-parse";
import {
  detectDocumentUploadKind,
  detectBatchImportKind,
  validateDocumentUploadContent,
  validateBatchImportContent,
} from "../../../../shared/upload/upload-file-validation.js";
import { parseSpreadsheetForBatchImport } from "../../../../shared/import/spreadsheet-import.js";
import { splitChildChunks, splitParentChunks } from "../document-chunker.js";
import { parseDoclingDocument } from "./docling.parser.js";
import { readImageDimensions } from "./image-dimensions.js";
import { parseDocumentBuffer } from "./registry.js";
import type { ParserContext } from "./types.js";
import { describeImageWithVision, newVisionStats } from "./vision-ocr.js";

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

  void it("skips small WebP before calling OCR", async () => {
    const buffer = webpHeader("VP8X", 32, 32);
    const stats = newVisionStats();
    const text = await describeImageWithVision(
      {
        buffer,
        mimeType: "image/webp",
        sourceLabel: "DOCX 装饰图",
        ...readImageDimensions(buffer),
        skipDecorative: true,
      },
      stats,
    );
    assert.equal(text, null);
    assert.equal(stats.skippedDecorative, 1);
    assert.equal(stats.attempted, 0);
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
  void it(
    "exports normalized heading levels and preserves their hierarchy in parent chunks",
    { skip: process.env["DOCLING_INTEGRATION"] !== "1" },
    async () => {
      const parsed = await parseDoclingDocument(
        Buffer.from("# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文内容"),
        "md",
      );
      const blocks = parsed.structuredBlocks ?? [];
      const headings = blocks.filter((block) => block.kind === "heading");
      const parents = splitParentChunks(blocks);

      assert.deepEqual(
        headings.map((block) => block.level),
        [1, 2, 3],
      );
      assert.deepEqual(
        parents.map((parent) => parent.content),
        ["正文内容"],
      );
      assert.deepEqual(parents[0]?.metadata.headingPath, ["一级标题", "二级标题", "三级标题"]);
    },
  );

  void it(
    "converts a real text PDF to Markdown while retaining page metadata",
    { skip: process.env["DOCLING_INTEGRATION"] !== "1" },
    async () => {
      const buffer = await readFile(new URL("./fixtures/text.pdf", import.meta.url));
      const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "pdf" });
      assert.match(parsed.text, /Parser regression document/);
      assert.match(parsed.text, /<!-- KNOWFLOW_PAGE_BREAK:1 -->/);
      assert.equal(parsed.metadata.parser, "docling");
      assert.equal(parsed.metadata.pdfPageCount, 1);
      assert.equal(parsed.metadata.scannedPdfDetected, undefined);
      assert.equal(parsed.metadata.visionImageCount, 0);
      assert.equal(parsed.metadata.contentFormat, "markdown");
      assert.equal(parsed.metadata.markdownDialect, "gfm");
      assert.ok((parsed.structuredBlocks?.length ?? 0) > 0);
      assert.ok(parsed.structuredBlocks?.some((block) => block.pageNumbers.includes(1)));
      const parents = splitParentChunks(parsed.structuredBlocks);
      assert.ok(parents.length > 0);
      assert.ok(parents.every((parent) => parent.pageStart === 1 && parent.pageEnd === 1));
      assert.ok(
        parents.every((parent) => parent.content.length > 0 && parent.content.length <= 2500),
      );
      const parentChildPairs = parents.flatMap((parent) =>
        splitChildChunks(parent.content).map((child) => ({ parent, child })),
      );
      assert.ok(parentChildPairs.length >= parents.length);
      assert.ok(
        parentChildPairs.every(
          ({ parent, child }) => child.content.length > 0 && parent.content.includes(child.content),
        ),
      );
    },
  );

  void it(
    "maps text from both pages across parent and child chunks without a forced page split",
    { skip: process.env["DOCLING_INTEGRATION"] !== "1" },
    async () => {
      const parsed = await parseDocumentBuffer(
        buildTextPdf([
          "UNIQUEPAGEONE alpha first sentence continues with enough searchable text for this page.",
          "UNIQUEPAGETWO beta second sentence continues with enough searchable text for this page.",
        ]),
        {
          ...context,
          sourceType: "pdf",
          mimeType: "application/pdf",
          documentId: "parser-multipage-regression",
        },
      );
      const blocks = parsed.structuredBlocks ?? [];
      const parents = splitParentChunks(blocks);

      assert.equal(parsed.metadata.parser, "docling");
      assert.equal(parsed.metadata.pdfPageCount, 2);
      assert.ok(blocks.some((block) => block.pageNumbers.includes(1)));
      assert.ok(blocks.some((block) => block.pageNumbers.includes(2)));
      assert.ok(parents.length > 0);
      assert.ok(
        parents.every((parent) => parent.content.length > 0 && parent.content.length <= 2500),
      );

      for (const [marker, expectedPage] of [
        ["UNIQUEPAGEONE", 1],
        ["UNIQUEPAGETWO", 2],
      ] as const) {
        const sourceBlock = blocks.find((block) => block.markdown.includes(marker));
        const parent = parents.find((candidate) => candidate.content.includes(marker));
        assert.ok(sourceBlock, `Docling must retain the source block for ${marker}`);
        assert.ok(parent, `a parent chunk must contain ${marker}`);
        assert.ok(sourceBlock.pageNumbers.includes(expectedPage));
        assert.ok(parent.pageStart !== null && parent.pageEnd !== null);
        assert.ok(parent.pageStart <= expectedPage && parent.pageEnd >= expectedPage);
      }
      assert.ok(
        parents.some((parent) => parent.pageStart === 1 && parent.pageEnd === 2),
        "a short semantic section spanning two pages should stay in one parent chunk",
      );

      const parentChildPairs = parents.flatMap((parent) =>
        splitChildChunks(parent.content).map((child) => ({ parent, child })),
      );
      assert.ok(parentChildPairs.length >= parents.length);
      assert.ok(
        parentChildPairs.every(
          ({ parent, child }) => child.content.length > 0 && parent.content.includes(child.content),
        ),
      );
    },
  );

  void it("keeps sparse PDFs on screenshot OCR and reports its original failure", async (t) => {
    // 模拟扫描件缺少文字和截图失败，不调用真实视觉模型；验证原有失败语义。
    t.mock.method(PDFParse.prototype, "getText", () =>
      Promise.resolve({
        total: 1,
        pages: [{ num: 1, text: "" }],
        text: "",
      }),
    );
    const screenshot = t.mock.method(PDFParse.prototype, "getScreenshot", () =>
      Promise.resolve({
        pages: [],
      }),
    );
    const buffer = await readFile(new URL("./fixtures/text.pdf", import.meta.url));
    await assert.rejects(
      parseDocumentBuffer(buffer, { ...context, sourceType: "pdf" }),
      /PDF 第 1 页渲染失败/,
    );
    assert.equal(screenshot.mock.callCount(), 1);
  });

  void it("preserves Markdown code, nested lists, tables and numeric text during cleaning", async () => {
    const markdown = [
      "# 标题",
      "",
      "123",
      "",
      "- 一级",
      "  - 二级",
      "",
      "```ts",
      "const value = 1;",
      "  // 保留代码缩进",
      "```",
      "",
      "| 字段 | 内容 |",
      "| --- | --- |",
      "| 链接 | [示例](https://example.com) |",
    ].join("\n");
    const parsed = await toParsedDocument(markdown, "docling");
    assert.match(parsed.text, /\n123\n/);
    assert.match(parsed.text, /- 一级\n {2}- 二级/);
    assert.match(parsed.text, /```ts\nconst value = 1;\n {2}\/\/ 保留代码缩进\n```/);
    assert.match(parsed.text, /\[示例\]\(https:\/\/example.com\)/);
    assert.equal(parsed.metadata.contentFormat, "markdown");
  });

  void it(
    "filters an embedded WebP decoration in a real DOCX without calling OCR",
    { skip: process.env["DOCLING_INTEGRATION"] !== "1" },
    async () => {
      const buffer = await readFile(new URL("./fixtures/decorative-webp.docx", import.meta.url));
      const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "docx" });
      assert.match(parsed.text, /装饰图之前的正文/);
      assert.match(parsed.text, /装饰图之后的正文/);
      assert.equal(parsed.text.includes("knowflow-images"), false);
      assert.equal(parsed.metadata.parser, "docling");
      assert.equal(parsed.metadata.visionImageSkippedCount, 1);
      assert.equal(parsed.metadata.visionImageCount, 0);
      assert.equal(parsed.metadata.visionImageFailedCount, 0);
    },
  );

  void it(
    "converts real Word headings, bold text and tables to Markdown",
    { skip: process.env["DOCLING_INTEGRATION"] !== "1" },
    async () => {
      const buffer = await readFile(new URL("./fixtures/structured.docx", import.meta.url));
      const parsed = await parseDocumentBuffer(buffer, { ...context, sourceType: "docx" });
      assert.match(parsed.text, /^## Business Process/m);
      assert.match(parsed.text, /\*\*Important content\*\*/);
      assert.match(parsed.text, /\| Field\s+\| Value\s+\|/);
      assert.match(parsed.text, /\| Owner\s+\| Team\s+\|/);
      assert.equal(parsed.metadata.contentFormat, "markdown");
    },
  );

  void it("dispatches UTF-8 text and Markdown through the same cleaner", async () => {
    for (const sourceType of ["txt"] as const) {
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

  void it("keeps complete-sentence child overlap within 60 characters after extraction", () => {
    const text = Array.from(
      { length: 300 },
      (_, index) => `第${String(index)}句用于验证子块重叠。`,
    ).join("");
    const children = splitChildChunks(text);
    assert.ok(children.length > 1);
    const previousSentences = children[0]?.content.match(/[^。！？.!?]+[。！？.!?]+/gu) ?? [];
    const nextChunk = children[1]?.content ?? "";
    let overlap = "";
    for (let index = 0; index < previousSentences.length; index += 1) {
      const candidate = previousSentences.slice(index).join("");
      if (candidate.length <= 60 && nextChunk.startsWith(candidate)) {
        overlap = candidate;
        break;
      }
    }
    assert.ok(overlap.length > 0 && overlap.length <= 60);
    assert.ok(children.every((child) => child.content.length <= 250));
  });
});
