// Docling 图片原位回填回归：顺序、去重、失败、预算、页码和服务协议。
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  backfillDoclingImages,
  parseDoclingDocument,
  type DoclingResult,
} from "./docling.parser.js";
import { prepareMarkdownImages } from "./markdown-images.js";
import { splitParentChunks, splitChildChunks } from "../document-chunker.js";

const nonce = "a".repeat(32);
// 构造 WebP 尺寸头验证字节类型识别，视觉内容本身由单元测试替身提供。
function image(width = 320, height = 240): string {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8);
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString("base64");
}
// 构造匹配适配层协议的图片节点。
function marker(index: number): string {
  return `<!-- KNOWFLOW_IMAGE:${nonce}:${String(index)} -->`;
}
// 构造单页结构结果，不依赖真实 Docling 服务。
function result(markdown: string, count = 1): DoclingResult {
  return {
    nonce,
    pages: [{ pageNumber: 1, markdown }],
    images: Array.from({ length: count }, (_, index) => ({
      marker: marker(index),
      base64: image(),
    })),
    warnings: [],
  };
}

void it("inserts raw descriptions between related paragraphs, without synthetic headings or markers", async () => {
  const parsed = await backfillDoclingImages(
    result(`# 流程\n\n图前正文\n\n${marker(0)}\n\n图后正文`),
    "pdf",
    (input, budget, stats) => {
      assert.equal(input.mimeType, "image/webp");
      assert.equal(input.width, 320);
      budget.used += 1;
      stats.attempted += 1;
      stats.inserted += 1;
      return Promise.resolve("图片显示：用户 → API → 数据库，价格 $&。");
    },
  );
  assert.ok(parsed.text.indexOf("图前正文") < parsed.text.indexOf("用户 → API"));
  assert.ok(parsed.text.indexOf("用户 → API") < parsed.text.indexOf("图后正文"));
  assert.match(parsed.text, /价格 \$&/);
  assert.doesNotMatch(parsed.text, /KNOWFLOW_IMAGE|## 文档图片|!\[/);
  assert.match(parsed.text, /KNOWFLOW_PAGE_BREAK:1/);
  const parents = splitParentChunks(parsed.text);
  assert.equal(parents.length, 1);
  assert.ok(
    splitChildChunks(parents[0]?.content ?? "").some((chunk) =>
      chunk.content.includes("用户 → API"),
    ),
  );
});

void it("recognizes identical bytes once and backfills every occurrence", async () => {
  let calls = 0;
  const parsed = await backfillDoclingImages(
    result(`前\n\n${marker(0)}\n\n中\n\n${marker(1)}\n\n后`, 2),
    "docx",
    () => {
      calls += 1;
      return Promise.resolve("同一张图的描述");
    },
  );
  assert.equal(calls, 1);
  assert.equal(parsed.text.split("同一张图的描述").length - 1, 2);
  assert.doesNotMatch(parsed.text, /KNOWFLOW_IMAGE/);
});

void it("removes missing and failed image nodes without moving surrounding text", async () => {
  const data = result(`前\n\n${marker(0)}\n\n中\n\n${marker(1)}\n\n后`);
  const parsed = await backfillDoclingImages(data, "md", () => Promise.resolve(null));
  assert.equal(parsed.text, "前\n\n中\n\n后");
  assert.ok(parsed.metadata.multimodalWarnings?.includes("docling_image_unavailable"));
});

void it("filters decorative WebP through the actual OCR helper before model calls", async () => {
  const data = result(`前\n\n${marker(0)}\n\n后`);
  const first = data.images[0];
  assert.ok(first);
  first.base64 = image(32, 32);
  const parsed = await backfillDoclingImages(data, "docx");
  assert.equal(parsed.metadata.visionImageSkippedCount, 1);
  assert.equal(parsed.metadata.visionImageCount, 0);
  assert.doesNotMatch(parsed.text, /KNOWFLOW_IMAGE/);
});

void it("keeps budgets shared across all pages and removes truncated nodes", async () => {
  const data = result("", 21);
  data.images = data.images.map((entry, index) => ({ ...entry, base64: image(320 + index, 240) }));
  data.pages = data.images.map((entry, index) => ({
    pageNumber: index + 1,
    markdown: `正文 ${String(index)}\n\n${entry.marker}`,
  }));
  const parsed = await backfillDoclingImages(data, "pdf", (_, budget, stats) => {
    if (budget.used >= budget.limit) {
      stats.truncated = true;
      return Promise.resolve(null);
    }
    budget.used += 1;
    stats.attempted += 1;
    stats.inserted += 1;
    return Promise.resolve("图的内容");
  });
  assert.equal(parsed.metadata.visionImageCount, 20);
  assert.equal(parsed.metadata.visionImageTruncated, true);
  assert.equal(parsed.metadata.pdfPageCount, 21);
  assert.doesNotMatch(parsed.text, /KNOWFLOW_IMAGE/);
});

void it("does not fetch local/private links or image syntax inside code examples", async (t) => {
  const requests = t.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected network");
  });
  const markdown =
    "![图](./images/a.png)\n\n![内网](http://127.0.0.1/a.png)\n\n```md\n![示例](https://example.com/a.png)\n```";
  const prepared = await prepareMarkdownImages(markdown);
  assert.equal(prepared.markdown, markdown);
  assert.deepEqual(prepared.warnings, ["markdown_image_unavailable"]);
  assert.equal(requests.mock.callCount(), 0);
});

void it("handles reference images at each occurrence without altering definitions or code", async (t) => {
  const previous = process.env["DOCLING_MD_IMAGE_ORIGINS"];
  process.env["DOCLING_MD_IMAGE_ORIGINS"] = "https://cdn.example.com";
  t.after(() => {
    if (previous === undefined) delete process.env["DOCLING_MD_IMAGE_ORIGINS"];
    else process.env["DOCLING_MD_IMAGE_ORIGINS"] = previous;
  });
  const requests = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(Buffer.from(image(), "base64"), { headers: { "content-type": "image/webp" } }),
    ),
  );
  const prepared = await prepareMarkdownImages(
    "前 ![说明][fig] 后\n\n![重复][fig]\n\n[fig]: https://cdn.example.com/a.webp",
  );
  assert.equal(requests.mock.callCount(), 1);
  assert.match(prepared.markdown, /前 !\[说明\]\(data:image\/webp;base64,/);
  assert.match(prepared.markdown, /\[fig\]: https:\/\/cdn.example.com/);
});

void it("fails explicitly on service errors and invalid protocol instead of degrading image placement", async (t) => {
  const requests = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response("unavailable", { status: 503 })),
  );
  await assert.rejects(parseDoclingDocument(Buffer.from("document"), "docx"), /HTTP 503/);
  requests.mock.mockImplementation(() =>
    Promise.resolve(Response.json({ nonce, pages: [], images: [], warnings: [] })),
  );
  await assert.rejects(parseDoclingDocument(Buffer.from("document"), "docx"), /格式不匹配/);
});
