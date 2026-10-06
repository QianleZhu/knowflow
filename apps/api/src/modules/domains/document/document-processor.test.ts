import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPdfTextWithVisualDescriptions, isScannedPdfText } from "./parsers/pdf.parser.js";
import { cleanParsedText } from "./parsers/cleaner.js";
import { isDecorativeImage } from "./parsers/vision-ocr.js";
import { readImageDimensions } from "./parsers/image-dimensions.js";
import { parseMarkdownBlocks, parsePlainTextBlocks } from "./parsers/structured-content.js";
import { splitParentChunks } from "./document-chunker.js";

const pageBreak = (page: number): string => `[[KNOWFLOW_PAGE_BREAK:${String(page)}]]`;

void describe("document text cleaning", () => {
  void it("removes control characters and merges PDF hard-wrapped paragraph lines", () => {
    const result = cleanParsedText(
      "制度正文第一行内容较长\u0000\n第二行继续说明同一段落\n\n下一段保留",
    );

    assert.equal(result.text, "制度正文第一行内容较长第二行继续说明同一段落\n\n下一段保留");
    assert.deepEqual(result.warnings, ["control_chars_removed"]);
  });

  void it("keeps markdown tables line-bounded while cleaning surrounding text", () => {
    const result = cleanParsedText(
      [
        "表格说明第一行内容较长",
        "第二行继续说明",
        "",
        "| 字段 | 含义 |",
        "| --- | --- |",
        "| owner | 负责人 |",
      ].join("\n"),
    );

    assert.match(result.text, /表格说明第一行内容较长第二行继续说明/);
    assert.match(result.text, /\| 字段 \| 含义 \|\n\| --- \| --- \|\n\| owner \| 负责人 \|/);
  });

  void it("removes repeated page chrome and standalone page numbers", () => {
    const result = cleanParsedText(
      [
        "Knowflow Handbook",
        "第一段正文内容足够长",
        "1",
        pageBreak(2),
        "Knowflow Handbook",
        "第二段正文内容足够长",
        "2",
      ].join("\n"),
    );

    assert.equal(result.text.includes("Knowflow Handbook"), false);
    assert.equal(result.text.includes("\n1\n"), false);
    assert.match(result.text, /第一段正文内容足够长/);
    assert.match(result.text, /第二段正文内容足够长/);
    assert.deepEqual(result.warnings, ["repeated_page_chrome_removed"]);
  });
});

// 节点来源优先于正文标记：父块只计算实际内容页，重复标题是上下文。
void describe("document chunking", () => {
  void it("keeps the full heading hierarchy including skipped levels", () => {
    const blocks = parseMarkdownBlocks(
      "# 第一章 总则\n\n正文\n\n### 管理要求\n\n说明\n\n## 适用范围\n\n范围正文",
    );
    const parents = splitParentChunks(blocks);
    assert.deepEqual(
      parents.map((parent) => parent.headingPath),
      [["第一章 总则"], ["第一章 总则", "管理要求"], ["第一章 总则", "适用范围"]],
    );
    assert.match(parents[1]?.content ?? "", /^# 第一章 总则\n\n### 管理要求/);
  });
  void it("does not guess headings in TXT comments or numbered paragraphs", () => {
    const blocks = parsePlainTextBlocks("# 代码注释\n    return 1\n\n第一章只是普通文本\n1. 正文");
    assert.ok(blocks.every((block) => block.kind === "paragraph"));
    const parents = splitParentChunks(blocks);
    assert.deepEqual(parents[0]?.headingPath, []);
    assert.match(parents[0].content, / {4}return 1/);
  });
  void it("merges short same-section paragraphs across pages", () => {
    const blocks = [
      ...parseMarkdownBlocks("# 总则\n\n第一页正文。", [1], "page1"),
      ...parseMarkdownBlocks("第二页正文。", [2], "page2"),
    ];
    const parents = splitParentChunks(blocks);
    assert.equal(parents.length, 1);
    assert.deepEqual(parents[0]?.pageNumbers, [1, 2]);
  });
  void it("does not widen later chunks to the page of a repeated heading", () => {
    const blocks = [
      ...parseMarkdownBlocks("# 长章节", [1], "page1"),
      ...[1, 2, 3].flatMap((page) =>
        parseMarkdownBlocks("制度正文内容".repeat(320), [page], `page${String(page)}`),
      ),
    ];
    const parents = splitParentChunks(blocks);
    assert.equal(parents.length, 3);
    assert.deepEqual(
      parents.map((parent) => parent.pageNumbers),
      [[1], [2], [3]],
    );
    assert.ok(parents.every((parent) => parent.content.startsWith("# 长章节")));
  });
});

void describe("document multimodal helpers", () => {
  void it("detects scanned PDFs by sparse text per page", () => {
    assert.equal(isScannedPdfText(`${pageBreak(1)}\n   \n${pageBreak(2)}\n短`, 2), true);
    assert.equal(isScannedPdfText(`${pageBreak(1)}\n${"制度正文".repeat(30)}`, 1), false);
  });

  void it("filters likely decorative images by size and keeps unknown dimensions", () => {
    assert.equal(isDecorativeImage(80, 80), true);
    assert.equal(isDecorativeImage(300, 20), true);
    assert.equal(isDecorativeImage(240, 180), false);
    assert.equal(isDecorativeImage(null, null), false);
  });

  void it("inserts PDF visual descriptions after their source pages", () => {
    const text = buildPdfTextWithVisualDescriptions(
      [
        { num: 1, text: "第一页正文" },
        { num: 2, text: "第二页正文" },
      ],
      [
        { pageNumber: 2, sourceLabel: "PDF 第 2 页图片 X", text: "第二页图片描述" },
        { pageNumber: 1, sourceLabel: "PDF 第 1 页图片 Y", text: "第一页图片描述" },
      ],
    );

    assert.match(text, /<!-- KNOWFLOW_PAGE_BREAK:1 -->\n\n第一页正文\n\n第一页图片描述/);
    assert.match(text, /<!-- KNOWFLOW_PAGE_BREAK:2 -->\n\n第二页正文\n\n第二页图片描述/);
  });

  void it("reads PNG dimensions for decorative filtering", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000012c000000c80802000000", "hex");

    assert.deepEqual(readImageDimensions(png), { width: 300, height: 200 });
  });
});
