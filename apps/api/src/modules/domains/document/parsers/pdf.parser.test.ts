// 使用真实 PDF 页面树与截图渲染测试路由，模型替身只控制 OCR 文本，不伪造页码或截图。
import assert from "node:assert/strict";
import { it } from "node:test";
import { parsePdfDocument } from "./pdf.parser.js";
import { toParsedDocument } from "./cleaner.js";
import { parseMarkdownBlocks } from "./structured-content.js";
import { splitChildChunks, splitParentChunks } from "../document-chunker.js";
import { buildTextPdf } from "./fixtures/pdf-fixtures.js";

// 模型替身记录被调用的物理页，并返回带跨页句子、表格的固定识别文本。
void it("maps all scanned pages and merges unfinished sentences without page sections", async () => {
  const pages: string[] = [];
  const parsed = await parsePdfDocument(buildTextPdf(["", "", ""]), {
    describe: (image, stats) => {
      assert.ok(image.buffer.length > 0 && (image.width ?? 0) > 0);
      assert.ok(image.prompt?.includes("完整转写"));
      pages.push(image.sourceLabel);
      stats.attempted += 1;
      stats.inserted += 1;
      const result = [
        "# 制度\n\n跨页句子的前半部分",
        "后半部分在下一页结束。",
        "## 范围\n\n第三页独立正文。",
      ][pages.length - 1];
      assert.ok(result);
      return Promise.resolve(result);
    },
    parseStructure: () => {
      throw new Error("全扫描文件不能调用文字解析");
    },
  });
  assert.deepEqual(parsed.metadata.ocrPageNumbers, [1, 2, 3]);
  assert.equal(pages.length, 3);
  const parents = splitParentChunks(parsed.structuredBlocks);
  assert.equal(parents.length, 2);
  assert.deepEqual(parents[0]?.pageNumbers, [1, 2]);
  assert.deepEqual(parents[1]?.pageNumbers, [3]);
  assert.match(parents[0].content, /前半部分后半部分/);
  assert.ok(
    !parents.some((parent) =>
      parent.metadata.headingPath.some((heading) => heading.includes("PDF 第")),
    ),
  );
  for (const parent of parents) assert.ok(splitChildChunks(parent.content, parent).length > 0);
});

void it("routes mixed PDFs per page and excludes OCR pages before Docling image backfill", async () => {
  const nativeText =
    "Native text has enough characters to be routed through the Docling document tree.";
  let calls = 0;
  const parsed = await parsePdfDocument(buildTextPdf([nativeText, "", nativeText]), {
    parseStructure: async (_buffer, format, excluded) => {
      assert.equal(format, "pdf");
      assert.deepEqual(excluded, [2]);
      const result = await toParsedDocument(nativeText, "docling");
      return {
        ...result,
        structuredBlocks: [
          ...parseMarkdownBlocks("# 章节\n\n原生第一页正文。", [1], "native1"),
          ...parseMarkdownBlocks("原生第三页正文。", [3], "native3"),
        ],
      };
    },
    describe: () => {
      calls += 1;
      return Promise.resolve("扫描第二页正文。");
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    parsed.structuredBlocks?.flatMap((block) => block.pageNumbers),
    [1, 1, 2, 3],
  );
  const parents = splitParentChunks(parsed.structuredBlocks);
  assert.equal(parents.length, 1);
  assert.deepEqual(parents[0]?.pageNumbers, [1, 2, 3]);
  assert.match(parents[0].content, /原生第一页正文。\n\n扫描第二页正文。\n\n原生第三页正文。/);
});

void it("retries a failed required OCR page and rejects partially recognized documents", async () => {
  let calls = 0;
  await assert.rejects(
    parsePdfDocument(buildTextPdf(["", ""]), {
      describe: (image) => {
        calls += 1;
        return Promise.resolve(image.sourceLabel.includes("1") ? "第一页正文。" : null);
      },
    }),
    /第 2 页视觉 OCR 失败/,
  );
  assert.equal(calls, 3);
});

void it("distinguishes an explicitly blank page from an OCR failure", async () => {
  const parsed = await parsePdfDocument(buildTextPdf(["", ""]), {
    describe: (image) =>
      Promise.resolve(image.sourceLabel.includes("1") ? "正文。" : "<!-- KNOWFLOW_BLANK_PAGE -->"),
  });
  assert.deepEqual(parsed.metadata.blankPageNumbers, [2]);
  assert.deepEqual(
    parsed.structuredBlocks?.map((block) => block.pageNumbers),
    [[1]],
  );
});

void it("processes every scanned page beyond twenty calls", async () => {
  let calls = 0;
  const parsed = await parsePdfDocument(buildTextPdf(Array.from({ length: 23 }, () => "")), {
    describe: (image, stats) => {
      calls += 1;
      stats.attempted += 1;
      stats.inserted += 1;
      return Promise.resolve(`${image.sourceLabel}的正文。`);
    },
  });
  assert.equal(calls, 23);
  assert.equal(parsed.metadata.visionImageInsertedCount, 23);
  assert.deepEqual(
    parsed.metadata.ocrPageNumbers,
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
  const parents = splitParentChunks(parsed.structuredBlocks);
  assert.deepEqual(
    [...new Set(parents.flatMap((parent) => parent.pageNumbers))],
    Array.from({ length: 23 }, (_, index) => index + 1),
  );
});

void it("unwraps model Markdown envelopes so cross-page tables remain tables", async () => {
  const parsed = await parsePdfDocument(buildTextPdf(["", ""]), {
    describe: (image) =>
      Promise.resolve(
        image.sourceLabel.includes("1")
          ? "| 编号 | 内容 |\n| --- | --- |\n| A | 第一页 |"
          : "```markdown\n| 编号 | 内容 |\n| --- | --- |\n| B | 第二页 |\n```",
      ),
  });
  assert.deepEqual(
    parsed.structuredBlocks?.map((block) => block.kind),
    ["table", "table"],
  );
  const parents = splitParentChunks(parsed.structuredBlocks);
  assert.equal(parents.length, 1);
  assert.deepEqual(parents[0]?.pageNumbers, [1, 2]);
  assert.equal(parents[0].blocks[0]?.table?.rows.length, 2);
});

void it("rejects adapter provenance outside the original physical page count", async () => {
  await assert.rejects(
    parsePdfDocument(
      buildTextPdf([
        "This native page has enough text to bypass screenshot OCR and use the structure adapter.",
      ]),
      {
        parseStructure: async () => ({
          ...(await toParsedDocument("正文", "docling")),
          structuredBlocks: parseMarkdownBlocks("正文", [9]),
        }),
      },
    ),
    /来源页码超出原始文档范围/,
  );
});
